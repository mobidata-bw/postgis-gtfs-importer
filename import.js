import {spawn} from 'node:child_process'
import {onExit} from 'signal-exit'
import {fileURLToPath} from 'node:url'
import _pg from 'pg'
const {Client} = _pg
import pgFormat from 'pg-format'
import {ok} from 'node:assert'
import {writeFile} from 'node:fs/promises'

const PATH_TO_IMPORT_SCRIPT = fileURLToPath(new URL('import.sh', import.meta.url).href)
const PATH_TO_DOWNLOAD_SCRIPT = fileURLToPath(new URL('download.sh', import.meta.url).href)

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

const importGtfsAtomically = async (cfg) => {
	const {
		logger,
		pgHost, pgUser, pgPassword, pgMetaDatabase,
		databaseNamePrefix,
		pathToImportScript,
		pathToDownloadScript,
		pathToDsnFile,
		gtfsDownloadUrl,
		gtfsDownloadUserAgent,
		tmpDir,
		gtfstidyBeforeImport,
		gtfsSqlDPath,
	} = {
		logger: console,
		pgHost: null,
		pgUser: null,
		pgPassword: null,
		pgMetaDatabase: process.env.PGDATABASE || null,
		pathToImportScript: PATH_TO_IMPORT_SCRIPT,
		pathToDownloadScript: PATH_TO_DOWNLOAD_SCRIPT,
		pathToDsnFile: process.env.GTFS_IMPORTER_DSN_FILE || null,
		gtfsDownloadUrl: null,
		gtfsDownloadUserAgent: null,
		tmpDir: '/tmp/gtfs',
		gtfstidyBeforeImport: null, // or `true` or `false`
		gtfsSqlDPath: null,
		...cfg,
	}
	ok(databaseNamePrefix, 'missing/empty cfg.databaseNamePrefix')
	ok(pathToImportScript, 'missing/empty cfg.pathToImportScript')
	ok(gtfsDownloadUrl, 'missing/empty cfg.gtfsDownloadUrl')
	ok(gtfsDownloadUserAgent, 'missing/empty cfg.gtfsDownloadUserAgent')

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
	logger.info(`downloading data to "${zipPath}"\n`)
	await pSpawn(pathToDownloadScript, [], {
		stdio: 'inherit',
		env: {
			...process.env,
			GTFS_TMP_DIR: tmpDir,
			GTFS_DOWNLOAD_URL: gtfsDownloadUrl,
			GTFS_DOWNLOAD_USER_AGENT: gtfsDownloadUserAgent,
		},
	})

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
				db_name: prevImport,
			}],
		} = await client.query('SELECT db_name FROM latest_import')
		if (prevImport !== null) {
			logger.info(`latest import is in database "${prevImport}", keeping it until the new import has succeeded`)
		}

		{
			const res = await client.query(`\
				SELECT datname AS db_name
				FROM pg_catalog.pg_database
				WHERE datname != $1
			`, [prevImport])
			const dbsToCleanUp = res.rows
			.map(r => r.db_name)
			.filter(dbName => dbName.slice(0, databaseNamePrefix.length) === databaseNamePrefix)
			.filter(dbName => /^\d+$/.test(dbName.slice(databaseNamePrefix.length)))

			for (const dbName of dbsToCleanUp) {
				logger.info(`dropping database "${dbName}" containing an older or unfinished import`)
				await dbMngmtClient.query(pgFormat('DROP DATABASE %I', dbName))
			}
		}

		const dbName = databaseNamePrefix + (Date.now() / 1000 | 0)

		logger.debug(`creating database "${dbName}"`)
		await dbMngmtClient.query(pgFormat('CREATE DATABASE %I', dbName))

		logger.info(`importing data into "${dbName}"\n`)
		const _importEnv = {
			...process.env,
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
		if (gtfstidyBeforeImport !== null) {
			_importEnv.GTFSTIDY_BEFORE_IMPORT = String(gtfstidyBeforeImport)
		}
		if (gtfsSqlDPath !== null) {
			_importEnv.GTFS_SQL_D_PATH = gtfsSqlDPath
		}
		await pSpawn(pathToImportScript, [], {
			stdio: 'inherit',
			env: _importEnv,
		})

		logger.info(`\nmarking the import into "${dbName}" as the latest`)
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
	}

	dbMngmtClient.end()
	client.end()
}

export {
	importGtfsAtomically,
}