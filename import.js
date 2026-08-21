import {fileURLToPath} from 'node:url'
import pgFormat from 'pg-format'
import {ok} from 'node:assert'
import {
	readdir,
	writeFile,
} from 'node:fs/promises'
import {
	digestString,
	digestFile,
	pSpawn,
	formatSchemaName,
	getPgConfig,
	getPgEnv,
	connectToDatabase,
	successfulImportsTableName,
	ensureSuccesfulImportsTableExists,
	queryImports,
	recordSuccessfulImport,
	removeImportFromLatestSuccessfulImports,
} from './index.js'

// expose npm-installed local CLI tools to child processes
import {createRequire} from 'node:module'
import {
	dirname,
	join as pathJoin,
} from 'node:path'
// todo: use import.meta.resolve once it is stable?
// see https://nodejs.org/docs/latest-v20.x/api/esm.html#importmetaresolvespecifier
const require = createRequire(import.meta.url)
const GTFS_VIA_POSTGRES_PKG = require.resolve('gtfs-via-postgres/package.json')
const NPM_BIN_DIR = dirname(dirname(GTFS_VIA_POSTGRES_PKG)) + '/.bin'

const PATH_TO_IMPORT_SCRIPT = fileURLToPath(new URL('import.sh', import.meta.url).href)
const PATH_TO_DOWNLOAD_SCRIPT = fileURLToPath(new URL('download.sh', import.meta.url).href)
const PATH_TO_POST_IMPORT_SCRIPT = fileURLToPath(new URL('post-import.sh', import.meta.url).href)

const importGtfsAtomically = async (cfg) => {
	const {
		logger,
		downloadScriptVerbose,
		connectDownloadScriptToStdout,
		importScriptVerbose,
		connectImportScriptToStdout,
		schemaNamePrefix,
		schemaName, // todo: rename to `metaSchemaName`?
		pathToImportScript,
		pathToDownloadScript,
		pathToPostImportScript,
		pathToEnvFile,
		gtfsDownloadUrl,
		gtfsDownloadUserAgent,
		tmpDir,
		gtfstidyBeforeImport,
		determineImportsToRetain,
		continueOnFailureDeletingOldImport,
		gtfsPostprocessingDPath,
		// gtfsPostImportDPath,
	} = {
		logger: console,
		downloadScriptVerbose: false,
		connectDownloadScriptToStdout: true,
		importScriptVerbose: true,
		connectImportScriptToStdout: true,
		schemaName: process.env.GTFS_IMPORTER_SCHEMA || 'public',
		pathToImportScript: process.env.GTFS_IMPORT_SCRIPT || PATH_TO_IMPORT_SCRIPT,
		pathToDownloadScript: process.env.GTFS_DOWNLOAD_SCRIPT || PATH_TO_DOWNLOAD_SCRIPT,
		pathToPostImportScript: process.env.GTFS_POST_IMPORT_SCRIPT || PATH_TO_POST_IMPORT_SCRIPT,
		pathToEnvFile: process.env.GTFS_IMPORTER_ENV_FILE || null,
		gtfsDownloadUrl: null,
		gtfsDownloadUserAgent: null,
		tmpDir: process.env.GTFS_TMP_DIR || '/tmp/gtfs',
		gtfstidyBeforeImport: null, // or `true` or `false`
		determineImportsToRetain: (latestSuccessfulImports, oldSchemas) => {
			return latestSuccessfulImports.slice(0, 2).map(_import => _import.schemaName)
		},
		continueOnFailureDeletingOldImport: process.env.GTFS_IMPORTED_CONTINUE_ON_FAILURE_DELETING_OLD_IMPORT === 'true',
		gtfsPostprocessingDPath: process.env.GTFS_POSTPROCESSING_D_PATH || '/etc/gtfs/postprocessing.d',
		// gtfsPostImportDPath: null,
		...cfg,
	}
	ok(schemaNamePrefix, 'missing/empty cfg.schemaNamePrefix')
	ok(pathToImportScript, 'missing/empty cfg.pathToImportScript')
	ok(pathToDownloadScript, 'missing/empty cfg.pathToDownloadScript')
	ok(pathToPostImportScript, 'missing/empty cfg.pathPostToImportScript')
	ok(gtfsDownloadUrl, 'missing/empty cfg.gtfsDownloadUrl')
	ok(gtfsDownloadUserAgent, 'missing/empty cfg.gtfsDownloadUserAgent')

	// todo: debug-log current git ref

	const result = {
		downloadDurationMs: null,
		deletedSchemas: [], // [schemaName]
		retainedSchemas: null, // [schemaName]
		importSkipped: false,
		newImport: null, // or {schemaName, importedAt, feedDigest}
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
			GTFS_IMPORTER_VERBOSE: downloadScriptVerbose ? 'true' : 'false',
		},
	})
	result.downloadDurationMs = performance.now() - _t0Download

	const pgConfig = await getPgConfig(cfg)
	const pgEnv = getPgEnv(pgConfig)

	// All of postgis-gtfs-importer's operations would have to run in a transaction to ensure consistent/atomic behaviour:
	// 1. reading from the latest imports table
	// 2. deleting old imports' schemas
	// 3. creating the new import's schema
	// 4. importing the GTFS data
	// 5. running post-processing scripts on the imported data
	// 6. in the imports table, marking the new import as the latest
	// However, because the actual import script (import.sh, doing steps 3-5) opens its own DB connection and transactions are connection-bound, we cannot run steps 1-2 & 6 in the same transaction. Therefore, we implement a workaround by
	// - introducing a "bookkeeping table", which only update after the import has finished successfully, and
	// - only considering an import usable once it has an entry in the bookkeeping table.
	// To do this, this file needs its own DB client.
	const client = await connectToDatabase(cfg)

	await ensureSuccesfulImportsTableExists({
		db: client,
		schemaName,
	})

	await client.query('BEGIN')
	try {
		logger.info(`obtaining exclusive lock on "${successfulImportsTableName}", so that only one import can be running`)
		// https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-TABLES
		// > Conflicts with the ROW SHARE, ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE, SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, and ACCESS EXCLUSIVE lock modes. This mode allows only concurrent ACCESS SHARE locks, i.e., only reads from the table can proceed in parallel with a transaction holding this lock mode.
		// > […]
		// > Only an ACCESS EXCLUSIVE lock blocks a SELECT (without FOR UPDATE/SHARE) statement.
		await client.query(pgFormat('LOCK TABLE %I IN EXCLUSIVE MODE NOWAIT', successfulImportsTableName))

		logger.debug('checking previous imports')

		let {
			latestSuccessfulImports,
			allSchemas,
		} = await queryImports({
			schemaNamePrefix,
			db: client,
		})
		let prevImport = null
		if (latestSuccessfulImports.length > 0) {
			logger.info(`there are ${latestSuccessfulImports.length} (most recent) successful imports recorded in the bookkeeping DB: ${latestSuccessfulImports.map(imp => imp.schemaName)}`)
			prevImport = latestSuccessfulImports[0]
		}
		// Although the import's schema will be created atomically (because it runs in a transaction), the import might fail afterwards (e.g. because this file's process is killed), so we might still have not-marked-as-ready imports.
		logger.debug('all schemas, including old/unfinished imports: ' + allSchemas.join(', '))
		for (let i = 0; i < latestSuccessfulImports.length; i++) {
			const prevImport = latestSuccessfulImports[i]

			if (!allSchemas.includes(prevImport.schemaName)) {
				logger.warn(`The "${successfulImportsTableName}" table points to a DB "${prevImport.schemaName}" which does not exist. This indicates either a bug in postgis-gtfs-importer, or that its state has been tampered with!`)
				// remove from list
				latestSuccessfulImports.splice(i, 1)
				i--
			}
		}

		{
			const importsToRetain = determineImportsToRetain(latestSuccessfulImports, allSchemas)
			ok(Array.isArray(importsToRetain), 'determineImportsToRetain() must return an array')
			logger.debug('imports to retain: ' + importsToRetain.join(', '))
			result.retainedSchemas = importsToRetain

			for (const schemaName of allSchemas) {
				if (importsToRetain.includes(schemaName)) {
					continue;
				}
				const isRecentSuccessfulImport = latestSuccessfulImports.some(imp => imp.schemaName === schemaName)
				if (isRecentSuccessfulImport) {
					logger.info(`dropping schema "${schemaName}" containing a (recent) successful import`)
				} else {
					logger.info(`dropping schema "${schemaName}" containing an older or unfinished import`)
				}

				try {
					await client.query(pgFormat('DROP SCHEMA %I CASCADE', schemaName))
					result.deletedSchemas.push(schemaName)
				} catch (err) {
					if (continueOnFailureDeletingOldImport) {
						logger.warn({
							error: err,
							schemaName,
						}, `failed to delete old schema "${schemaName}"`)
					} else {
						throw err
					}
				}
				if (isRecentSuccessfulImport) {
					await removeImportFromLatestSuccessfulImports({
						db: client,
						schemaName,
					})
				}
			}
		}

		// todo: also take gtfs-via-postgres version into account
		const zipDigest = await digestFile(zipPath)
		let feedDigest = zipDigest

		// if $GTFS_POSTPROCESSING_D_PATH contains files, hash them into `feedDigest`
		if (gtfsPostprocessingDPath !== null) {
			let files = []
			// todo: DRY this with the postprocessing logic in import.js
			try {
				const allFiles = await readdir(gtfsPostprocessingDPath)
				// Bash `*` globs ignore dotfiles
				files = allFiles.filter(filename => filename[0] !== '.')
			} catch (err) {
				// allow the postprocessing.d directory to be missing
				if (err.code !== 'ENOENT') {
					throw err
				}
			}

			if (files.length > 0) {
				let filesDigest = ''
				logger.debug(`adding ${files.length} files' hashes to feed_digest`)
				for (const file of files) {
					const path = pathJoin(gtfsPostprocessingDPath, file)
					filesDigest += await digestFile(path)
				}
				feedDigest = digestString(feedDigest + filesDigest)
			}
		}

		const importedAt = (Date.now() / 1000 | 0)
		const schemaName = formatSchemaName({
			schemaNamePrefix,
			importedAt,
			feedDigest,
		})
		if (prevImport?.feedDigest === feedDigest) {
			result.importSkipped = true
			logger.info('GTFS feed digest has not changed, skipping import')
			return result
		}
		result.newImport = {
			schemaName,
			importedAt,
			feedDigest,
		}

		logger.info(`importing data into "${schemaName}"`)
		const _importEnv = {
			...process.env,
			...pgEnv,
			PATH: NPM_BIN_DIR + ':' + process.env.PATH,
			GTFS_IMPORTER_SCHEMA: schemaName,
			GTFS_TMP_DIR: tmpDir,
			GTFS_IMPORTER_VERBOSE: importScriptVerbose ? 'true' : 'false',
			GTFS_FEED_DIGEST: feedDigest,
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

		logger.info(`marking the import into "${schemaName}" as the latest`)
		await recordSuccessfulImport({
			db: client,
			successfulImport: {
				schemaName,
				importedAt,
				feedDigest,
			},
		})

		if (pathToEnvFile !== null) {
			const env = `\
GTFS_DB_SCHEMA="${schemaName}"
`
			logger.debug(`writing env file ${pathToEnvFile}`)
			await writeFile(pathToEnvFile, env)
		}

		logger.info(`import succeeded, committing all changes to "${successfulImportsTableName}"!`)
		// also releases the lock on latest_successful_imports_v2
		await client.query('COMMIT')
	} catch (err) {
		logger.warn('an error occured, rolling back')
		// The newly created DB will remain, potentially with data inside. But it will be cleaned up during the next run.
		// also releases the lock on latest_successful_imports_v2
		await client.query('ROLLBACK')
		throw err
	} finally {
		client.end()
	}

	logger.debug('done!')
	return result
}

export {
	importGtfsAtomically,
}
