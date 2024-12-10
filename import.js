import {fileURLToPath} from 'node:url'
import pgFormat from 'pg-format'
import {ok} from 'node:assert'
import {writeFile} from 'node:fs/promises'
import {
	digestFile,
	pSpawn,
	formatDbName,
	getPgConfig,
	getPgEnv,
	connectToMetaDatabase,
	successfulImportsTableName,
	ensureSuccesfulImportsTableExists,
	queryImports,
	recordSuccessfulImport,
	removeDbFromLatestSuccessfulImports,
} from './index.js'

// expose npm-installed local CLI tools to child processes
import {createRequire} from 'node:module'
import {dirname} from 'node:path'
// todo: use import.meta.resolve once it is stable?
// see https://nodejs.org/docs/latest-v20.x/api/esm.html#importmetaresolvespecifier
const require = createRequire(import.meta.url)
const GTFS_VIA_POSTGRES_PKG = require.resolve('gtfs-via-postgres/package.json')
const NPM_BIN_DIR = dirname(dirname(GTFS_VIA_POSTGRES_PKG)) + '/.bin'

const PATH_TO_IMPORT_SCRIPT = fileURLToPath(new URL('import.sh', import.meta.url).href)
const PATH_TO_DOWNLOAD_SCRIPT = fileURLToPath(new URL('download.sh', import.meta.url).href)

const importGtfsAtomically = async (cfg) => {
	const {
		logger,
		downloadScriptVerbose,
		connectDownloadScriptToStdout,
		importScriptVerbose,
		connectImportScriptToStdout,
		databaseNamePrefix,
		schemaName,
		pathToImportScript,
		pathToDownloadScript,
		pathToDsnFile,
		gtfsDownloadUrl,
		gtfsDownloadUserAgent,
		tmpDir,
		gtfstidyBeforeImport,
		determineDbsToRetain,
		continueOnFailureDeletingOldDb,
		gtfsPostprocessingDPath,
	} = {
		logger: console,
		downloadScriptVerbose: true,
		connectDownloadScriptToStdout: true,
		importScriptVerbose: true,
		connectImportScriptToStdout: true,
		schemaName: process.env.GTFS_IMPORTER_SCHEMA || null,
		pathToImportScript: PATH_TO_IMPORT_SCRIPT,
		pathToDownloadScript: PATH_TO_DOWNLOAD_SCRIPT,
		pathToDsnFile: process.env.GTFS_IMPORTER_DSN_FILE || null,
		gtfsDownloadUrl: null,
		gtfsDownloadUserAgent: null,
		tmpDir: process.env.GTFS_TMP_DIR || '/tmp/gtfs',
		gtfstidyBeforeImport: null, // or `true` or `false`
		determineDbsToRetain: (latestSuccessfulImports, oldDbs) => {
			return latestSuccessfulImports.slice(0, 2).map(_import => _import.dbName)
		},
		continueOnFailureDeletingOldDb: process.env.GTFS_IMPORTED_CONTINUE_ON_FAILURE_DELETING_OLD_DB === 'true',
		gtfsPostprocessingDPath: null,
		...cfg,
	}
	ok(databaseNamePrefix, 'missing/empty cfg.databaseNamePrefix')
	ok(pathToImportScript, 'missing/empty cfg.pathToImportScript')
	ok(gtfsDownloadUrl, 'missing/empty cfg.gtfsDownloadUrl')
	ok(gtfsDownloadUserAgent, 'missing/empty cfg.gtfsDownloadUserAgent')

	const result = {
		downloadDurationMs: null,
		deletedDatabases: [], // [dbName]
		retainedDatabases: null, // [dbName]
		importSkipped: false,
		database: null, // or {dbName, importedAt, feedDigest}
		importDurationMs: null,
	}

	// todo: DRY with lib.sh
	const zipPath = `${tmpDir}/gtfs.zip`
	logger.info(`downloading data to "${zipPath}"`)
	const _t0Download = performance.now()
	await pSpawn(pathToDownloadScript, [], {
		stdio: [
			'inherit',
			connectDownloadScriptToStdout ? 'inherit' : 'ignore',
			'inherit',
		],
		env: {
			...process.env,
			GTFS_TMP_DIR: tmpDir,
			GTFS_DOWNLOAD_URL: gtfsDownloadUrl,
			GTFS_DOWNLOAD_USER_AGENT: gtfsDownloadUserAgent,
			GTFS_DOWNLOAD_VERBOSE: downloadScriptVerbose ? 'true' : 'false',
		},
	})
	result.downloadDurationMs = performance.now() - _t0Download

	const pgConfig = await getPgConfig(cfg)
	const pgEnv = getPgEnv(pgConfig)

	// `CREATE/DROP DATABASE` can't be run within the transation, so we need need a separate client for it.
	// Thus, a newly created database also won't be removed if the transaction fails or is aborted, so we
	// have to drop it manually when cleaning up failed/aborted imports.
	const dbMngmtClient = await connectToMetaDatabase(cfg)

	const client = await connectToMetaDatabase(cfg)

	await ensureSuccesfulImportsTableExists({
		db: client,
	})

	await client.query('BEGIN')
	try {
		logger.info(`obtaining exclusive lock on "${successfulImportsTableName}", so that only one import can be running`)
		// https://www.postgresql.org/docs/14/explicit-locking.html#LOCKING-TABLES
		// > Conflicts with the ROW SHARE, ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE, SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, and ACCESS EXCLUSIVE lock modes. This mode allows only concurrent ACCESS SHARE locks, i.e., only reads from the table can proceed in parallel with a transaction holding this lock mode.
		//> Only an ACCESS EXCLUSIVE lock blocks a SELECT (without FOR UPDATE/SHARE) statement.
		await client.query(pgFormat('LOCK TABLE %I IN EXCLUSIVE MODE NOWAIT', successfulImportsTableName))

		logger.debug('checking previous imports')

		let {
			latestSuccessfulImports,
			allDbs,
		} = await queryImports({
			databaseNamePrefix,
			db: client,
		})
		let prevImport = null
		if (latestSuccessfulImports.length > 0) {
			logger.info(`there are ${latestSuccessfulImports.length} (most recent) successful imports recorded in the bookkeeping DB: ${latestSuccessfulImports.map(imp => imp.dbName)}`)
			prevImport = latestSuccessfulImports[0]
		}
		logger.debug('all DBs, including old/unfinished imports: ' + allDbs.join(', '))
		for (let i = 0; i < latestSuccessfulImports.length; i++) {
			const prevImport = latestSuccessfulImports[i]

			if (!allDbs.includes(prevImport.dbName)) {
				logger.warn(`The "${successfulImportsTableName}" table points to a DB "${prevImport.dbName}" which does not exist. This indicates either a bug in postgis-gtfs-importer, or that its state has been tampered with!`)
				// remove from list
				latestSuccessfulImports.splice(i, 1)
				i--
			}
		}

		{
			const dbsToRetain = determineDbsToRetain(latestSuccessfulImports, allDbs)
			ok(Array.isArray(dbsToRetain), 'determineDbsToRetain() must return an array')
			logger.debug('dbs to retain: ' + dbsToRetain.join(', '))
			result.retainedDatabases = dbsToRetain

			for (const dbName of allDbs) {
				if (dbsToRetain.includes(dbName)) {
					continue;
				}
				const isRecentSuccessfulImport = latestSuccessfulImports.find(imp => imp.dbName === dbName)
				if (isRecentSuccessfulImport) {
					logger.info(`dropping database "${dbName}" containing a (recent) successful import`)
				} else {
					logger.info(`dropping database "${dbName}" containing an older or unfinished import`)
				}

				// todo: `WITH (FORCE)`? – https://stackoverflow.com/a/68982312/1072129
				try {
					await dbMngmtClient.query(pgFormat('DROP DATABASE %I', dbName))
					result.deletedDatabases.push(dbName)
				} catch (err) {
					if (continueOnFailureDeletingOldDb) {
						logger.warn({
							error: err,
							dbName,
						}, `failed to delete old database "${dbName}"`)
					} else {
						throw err
					}
				}
				if (isRecentSuccessfulImport) {
					await removeDbFromLatestSuccessfulImports({
						db: client,
						dbName,
					})
				}
			}
		}

		const zipDigest = await digestFile(zipPath)
		const importedAt = (Date.now() / 1000 | 0)
		const dbName = formatDbName({
			databaseNamePrefix,
			importedAt,
			zipDigest,
		})
		if (prevImport?.feedDigest === zipDigest) {
			result.importSkipped = true
			logger.info('GTFS feed digest has not changed, skipping import')
			return result
		}
		result.database = {
			dbName,
			importedAt,
			feedDigest: zipDigest,
		}

		logger.debug(`creating database "${dbName}"`)
		await dbMngmtClient.query(pgFormat('CREATE DATABASE %I', dbName))

		logger.info(`importing data into "${dbName}"`)
		const _importEnv = {
			...process.env,
			...pgEnv,
			PATH: NPM_BIN_DIR + ':' + process.env.PATH,
			PGDATABASE: dbName,
			GTFS_TMP_DIR: tmpDir,
			GTFS_IMPORTER_VERBOSE: importScriptVerbose ? 'true' : 'false',
		}
		if (schemaName !== null) {
			_importEnv.GTFS_IMPORTER_SCHEMA = schemaName
		}
		if (gtfstidyBeforeImport !== null) {
			_importEnv.GTFSTIDY_BEFORE_IMPORT = String(gtfstidyBeforeImport)
		}
		if (gtfsPostprocessingDPath !== null) {
			_importEnv.GTFS_POSTPROCESSING_D_PATH = gtfsPostprocessingDPath
		}
		const _t0Import = performance.now()
		await pSpawn(pathToImportScript, [], {
			stdio: [
				'inherit',
				connectImportScriptToStdout ? 'inherit' : 'ignore',
				'inherit',
			],
			env: _importEnv,
		})
		result.importDurationMs = performance.now() - _t0Import
		logger.debug(`import succeeded in ${Math.round(result.importDurationMs / 1000)}s`)

		logger.info(`marking the import into "${dbName}" as the latest`)
		await recordSuccessfulImport({
			db: client,
			successfulImport: {
				dbName,
				importedAt,
				feedDigest: zipDigest,
			},
		})

		if (pathToDsnFile !== null) {
			// https://www.pgbouncer.org/config.html#section-databases
			// https://www.postgresql.org/docs/15/libpq-connect.html#id-1.7.3.8.3.5
			const {
				PGHOST,
				PGPORT,
				POSTGREST_USER,
				POSTGREST_PASSWORD,
			} = process.env
			ok(PGHOST, 'missing/empty $PGHOST')
			ok(PGPORT, 'missing/empty $PGPORT')
			// todo: why `POSTGREST_`? rename to e.g. `PGBOUNCER_`?
			ok(POSTGREST_USER, 'missing/empty $POSTGREST_USER')
			ok(POSTGREST_PASSWORD, 'missing/empty $POSTGREST_PASSWORD')

			const dsn = `gtfs=host=${PGHOST} port=${PGPORT} dbname=${dbName} user=${POSTGREST_USER} password=${POSTGREST_PASSWORD}`
			const logDsn = `gtfs=host=${PGHOST} port=${PGPORT} dbname=${dbName} user=${POSTGREST_USER} password=${POSTGREST_PASSWORD.slice(0, 2)}…${POSTGREST_PASSWORD.slice(-2)}`
			logger.debug(`writing "${logDsn}" into env file ${pathToDsnFile}`)
			await writeFile(pathToDsnFile, dsn)
		}

		logger.info(`import succeeded, committing all changes to "${successfulImportsTableName}"!`)
		await client.query('COMMIT')
	} catch (err) {
		logger.warn('an error occured, rolling back')
		// The newly created DB will remain, potentially with data inside. But it will be cleaned up during the next run.
		await client.query('ROLLBACK')
		throw err
	} finally {
		dbMngmtClient.end()
		client.end()
	}

	logger.debug('done!')
	return result
}

export {
	importGtfsAtomically,
}
