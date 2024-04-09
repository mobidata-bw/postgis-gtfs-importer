import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {spawn} from 'node:child_process'
import {onExit} from 'signal-exit'
import {fileURLToPath} from 'node:url'
import _pg from 'pg'
const {Client} = _pg
import pgFormat from 'pg-format'
import {deepStrictEqual, fail, ok} from 'node:assert'
import {writeFile} from 'node:fs/promises'

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

const DIGEST_LENGTH = 6
const digestFile = async (pathToFile) => {
	const hash = createHash('sha256')
	for await (const chunk of createReadStream(pathToFile)) {
		hash.update(chunk)
	}
	return hash.digest('hex').slice(0, DIGEST_LENGTH).toLowerCase()
}

const pSpawn = (path, args = [], opts = {}) => {
	return new Promise((resolve, reject) => {
		const proc = spawn(path, args, opts)
		// https://github.com/sindresorhus/execa/blob/f4b8b3ab601c94d1503f1010822952758dcc6350/lib/kill.js#L95-L101
		const stopListening = onExit(() => {
			proc.kill()
		})
		proc.once('error', (err) => {
			reject(err)
			stopListening()
			proc.kill()
		})
		proc.once('exit', (code, signal) => {
			if (code === 0) {
				resolve()
			} else {
				const err = new Error(`${path} exited with ${code} (${signal})`)
				err.code = code
				err.signal = signal
				err.proc = proc
				reject(err)
			}
			stopListening()
		})
	})
}

const parseDbName = (name, namePrefix) => {
	if (name.slice(0, namePrefix.length) !== namePrefix) return null
	const match = new RegExp(`^(\\d{10,})_([0-9a-f]{${DIGEST_LENGTH}})$`).exec(name.slice(namePrefix.length))
	if (!match) return null
	return {
		name,
		importedAt: parseInt(match[1]),
		feedDigest: match[2],
	}
}
deepStrictEqual(
	parseDbName('gtfs_nyct_subway_1712169379_0f1deb', 'gtfs_nyct_subway_'),
	{name: 'gtfs_nyct_subway_1712169379_0f1deb', importedAt: 1712169379, feedDigest: '0f1deb'},
)

const importGtfsAtomically = async (cfg) => {
	const {
		logger,
		pgHost, pgUser, pgPassword, pgMetaDatabase,
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
		gtfsSqlDPath,
	} = {
		logger: console,
		pgHost: null,
		pgUser: null,
		pgPassword: null,
		pgMetaDatabase: process.env.PGDATABASE || null,
		schemaName: process.env.GTFS_IMPORTER_SCHEMA || null,
		pathToImportScript: PATH_TO_IMPORT_SCRIPT,
		pathToDownloadScript: PATH_TO_DOWNLOAD_SCRIPT,
		pathToDsnFile: process.env.GTFS_IMPORTER_DSN_FILE || null,
		gtfsDownloadUrl: null,
		gtfsDownloadUserAgent: null,
		tmpDir: '/tmp/gtfs',
		gtfstidyBeforeImport: null, // or `true` or `false`
		determineDbsToRetain: oldDbs => oldDbs, // all
		gtfsSqlDPath: null,
		...cfg,
	}
	ok(databaseNamePrefix, 'missing/empty cfg.databaseNamePrefix')
	ok(pathToImportScript, 'missing/empty cfg.pathToImportScript')
	ok(gtfsDownloadUrl, 'missing/empty cfg.gtfsDownloadUrl')
	ok(gtfsDownloadUserAgent, 'missing/empty cfg.gtfsDownloadUserAgent')

	const result = {
		downloadDurationMs: null,
		deletedDatabases: [], // [{name, importedAt, feedDigest}]
		retainedDatabases: null, // [{name, importedAt, feedDigest}]
		importSkipped: false,
		database: null, // or {name, importedAt, feedDigest}
		importDurationMs: null,
	}

	const pgConfig = {}
	if (pgHost !== null) {
		pgConfig.host = pgHost
	}
	if (pgUser !== null) {
		pgConfig.user = pgUser
	}
	if (pgPassword !== null) {
		pgConfig.password = pgPassword
	}
	if (pgMetaDatabase !== null) {
		pgConfig.database = pgMetaDatabase
	}

	// todo: DRY with lib.sh
	const zipPath = `${tmpDir}/gtfs.zip`
	logger.info(`downloading data to "${zipPath}"`)
	const _t0Download = performance.now()
	await pSpawn(pathToDownloadScript, [], {
		stdio: 'inherit',
		env: {
			...process.env,
			GTFS_TMP_DIR: tmpDir,
			GTFS_DOWNLOAD_URL: gtfsDownloadUrl,
			GTFS_DOWNLOAD_USER_AGENT: gtfsDownloadUserAgent,
		},
	})
	result.downloadDurationMs = performance.now() - _t0Download

	// `CREATE/DROP DATABASE` can't be run within the transation, so we need need a separate client for it.
	// Thus, a newly created database also won't be removed if the transaction fails or is aborted, so we
	// have to drop it manually when cleaning up failed/aborted imports.
	const dbMngmtClient = new Client(pgConfig)
	await dbMngmtClient.connect()

	const client = new Client(pgConfig)
	await client.connect()

	// We only ever keep one row in `latest_import`, which contains NULL in the beginning.
	await client.query(`\
		CREATE TABLE IF NOT EXISTS latest_import (
			db_name TEXT,
			always_true BOOLEAN DEFAULT True UNIQUE
		);
		INSERT INTO latest_import (db_name, always_true)
		VALUES (NULL, True)
		ON CONFLICT (always_true) DO NOTHING;
	`)

	await client.query('BEGIN')
	try {
		logger.info('obtaining exclusive lock on "latest_import", so that only one import can be running')
		// https://www.postgresql.org/docs/14/explicit-locking.html#LOCKING-TABLES
		// > Conflicts with the ROW SHARE, ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE, SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, and ACCESS EXCLUSIVE lock modes. This mode allows only concurrent ACCESS SHARE locks, i.e., only reads from the table can proceed in parallel with a transaction holding this lock mode.
		//> Only an ACCESS EXCLUSIVE lock blocks a SELECT (without FOR UPDATE/SHARE) statement.
		await client.query('LOCK TABLE latest_import IN EXCLUSIVE MODE NOWAIT')

		logger.debug('checking previous imports')

		const {
			rows: [{
				db_name: _prevImportName,
			}],
		} = await client.query('SELECT db_name FROM latest_import')
		if (_prevImportName !== null) {
			logger.info(`latest import is in database "${_prevImportName}", keeping it until the new import has succeeded`)
		}
		let prevImport = _prevImportName
			? parseDbName(_prevImportName, databaseNamePrefix)
			: null

		{
			const res = await client.query(`\
				SELECT datname AS db_name
				FROM pg_catalog.pg_database
				ORDER BY datname ASC
			`)
			const oldDbs = res.rows
			.map(r => parseDbName(r.db_name, databaseNamePrefix))
			.filter(parsed => Boolean(parsed))
			logger.debug('old DBs, including previous import: ' + oldDbs.map(db => db.name).join(', '))
			if (prevImport && !oldDbs.some(({name}) => name === prevImport.name)) {
				logger.warn(`The latest_import table points to a database "${prevImport.name}" which does not exist. This indicates either a bug in postgis-gtfs-importer, or that its state has been tampered with!`)
				prevImport = null
			}

			const dbsToRetain = determineDbsToRetain(oldDbs)
			ok(Array.isArray(dbsToRetain), 'determineDbsToRetain() must return an array')
			if (prevImport && !dbsToRetain.some(({name}) => name === prevImport.name)) {
				fail(`determineDbsToRetain() must retain the previous import "${prevImport.name}"`)
			}
			result.retainedDatabases = dbsToRetain

			const _dbsToRetain = new Set(dbsToRetain.map(db => db.name))
			for (const oldDb of oldDbs) {
				if (_dbsToRetain.has(oldDb.name)) {
					continue;
				}
				logger.info(`dropping database "${oldDb.name}" containing an older or unfinished import`)
				await dbMngmtClient.query(pgFormat('DROP DATABASE %I', oldDb.name))
				result.deletedDatabases.push(oldDb)
			}
		}

		const zipDigest = await digestFile(zipPath)
		const importedAt = (Date.now() / 1000 | 0)
		const dbName = [
			databaseNamePrefix,
			importedAt,
			'_',
			zipDigest,
		].join('')
		if (prevImport?.feedDigest === zipDigest) {
			result.importSkipped = true
			logger.info('GTFS feed digest has not changed, skipping import')
			return result
		}
		result.database = {
			name: dbName,
			importedAt,
			feedDigest: zipDigest,
		}

		logger.debug(`creating database "${dbName}"`)
		await dbMngmtClient.query(pgFormat('CREATE DATABASE %I', dbName))

		logger.info(`importing data into "${dbName}"`)
		const _importEnv = {
			...process.env,
			PATH: NPM_BIN_DIR + ':' + process.env.PATH,
			PGDATABASE: dbName,
			GTFS_TMP_DIR: tmpDir,
		}
		if (pgHost !== null) {
			_importEnv.PGHOST = pgHost
		}
		if (pgUser !== null) {
			_importEnv.PGUSER = pgUser
		}
		if (pgPassword !== null) {
			_importEnv.PGPASSWORD = pgPassword
		}
		if (schemaName !== null) {
			_importEnv.GTFS_IMPORTER_SCHEMA = schemaName
		}
		if (gtfstidyBeforeImport !== null) {
			_importEnv.GTFSTIDY_BEFORE_IMPORT = String(gtfstidyBeforeImport)
		}
		if (gtfsSqlDPath !== null) {
			_importEnv.GTFS_SQL_D_PATH = gtfsSqlDPath
		}
		const _t0Import = performance.now()
		await pSpawn(pathToImportScript, [], {
			stdio: 'inherit',
			env: _importEnv,
		})
		result.importDurationMs = performance.now() - _t0Import

		logger.info(`marking the import into "${dbName}" as the latest`)
		await client.query(`\
			INSERT INTO latest_import (db_name, always_true)
			VALUES ($1, True)
			ON CONFLICT (always_true) DO UPDATE SET db_name = $1;
		`, [dbName])

		if (pathToDsnFile !== null) {
			// https://www.pgbouncer.org/config.html#section-databases
			// https://www.postgresql.org/docs/15/libpq-connect.html#id-1.7.3.8.3.5
			const {
				PGHOST,
				POSTGREST_USER,
				POSTGREST_PASSWORD,
			} = process.env
			ok(PGHOST, 'missing/empty $PGHOST')
			ok(POSTGREST_USER, 'missing/empty $POSTGREST_USER')
			ok(POSTGREST_PASSWORD, 'missing/empty $POSTGREST_PASSWORD')

			const dsn = `gtfs=host=${PGHOST} dbname=${dbName} user=${POSTGREST_USER} password=${POSTGREST_PASSWORD}`
			const logDsn = `gtfs=host=${PGHOST} dbname=${dbName} user=${POSTGREST_USER} password=${POSTGREST_PASSWORD.slice(0, 2)}…${POSTGREST_PASSWORD.slice(-2)}`
			logger.debug(`writing "${logDsn}" into env file ${pathToDsnFile}`)
			await writeFile(pathToDsnFile, dsn)
		}

		logger.info('import succeeded, committing all changes to "latest_import"!')
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
