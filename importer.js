#!/usr/bin/env node

import {spawn} from 'node:child_process'
import {onExit} from 'signal-exit'
import {fileURLToPath} from 'node:url'
import _pg from 'pg'
const {Client} = _pg
import pgFormat from 'pg-format'
import {ok} from 'node:assert'
import {writeFile} from 'node:fs/promises'

const PATH_TO_IMPORT_SCRIPT = fileURLToPath(new URL('import.sh', import.meta.url).href)

const GTFS_IMPORTER_DB_PREFIX = process.env.GTFS_IMPORTER_DB_PREFIX
if (!GTFS_IMPORTER_DB_PREFIX) {
	console.error('Missing/empty $GTFS_IMPORTER_DB_PREFIX.')
	process.exit(1)
}
const DB_PREFIX = GTFS_IMPORTER_DB_PREFIX + '_'

const PATH_TO_DSN_FILE = process.env.GTFS_IMPORTER_DSN_FILE || null

const pSpawn = (path, args = [], opts = {}) => {
	return new Promise((resolve, reject) => {
		const proc = spawn(PATH_TO_IMPORT_SCRIPT, args, opts)
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
				const err = new Error(`${PATH_TO_IMPORT_SCRIPT} exited with ${code} (${signal})`)
				err.code = code
				err.signal = signal
				err.proc = proc
				reject(err)
			}
			stopListening()
		})
	})
}

// `CREATE/DROP DATABASE` can't be run within the transation, so we need need a separate client for it.
// Thus, a newly created database also won't be removed if the transaction fails or is aborted, so we
// have to drop it manually when cleaning up failed/aborted imports.
const dbMngmtClient = new Client()
await dbMngmtClient.connect()

const client = new Client()
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
	console.info('obtaining exclusive lock on "latest_import", so that only one import can be running')
	// https://www.postgresql.org/docs/current/sql-lock.html
	await client.query('LOCK TABLE latest_import IN ACCESS EXCLUSIVE MODE NOWAIT')
	
	console.info('')

	const {
		rows: [{
			db_name: prevImport,
		}],
	} = await client.query('SELECT db_name FROM latest_import')
	if (prevImport !== null) {
		console.info(`latest import is in database "${prevImport}", keeping it until the new import has succeeded`)
	}

	{
		const res = await client.query(`\
			SELECT datname AS db_name
			FROM pg_catalog.pg_database
			WHERE datname != $1
		`, [prevImport])
		const dbsToCleanUp = res.rows
		.map(r => r.db_name)
		.filter(dbName => dbName.slice(0, DB_PREFIX.length) === DB_PREFIX)
		.filter(dbName => /^\d+$/.test(dbName.slice(DB_PREFIX.length)))

		for (const dbName of dbsToCleanUp) {
			console.info(`dropping database "${dbName}" containing an older or unfinished import`)
			await dbMngmtClient.query(pgFormat('DROP DATABASE %I', dbName))
		}
	}

	console.info('')
	const dbName = DB_PREFIX + (Date.now() / 1000 | 0)

	console.info(`creating database "${dbName}"`)
	await dbMngmtClient.query(pgFormat('CREATE DATABASE %I', dbName))

	console.info(`importing data into "${dbName}"\n`)
	await pSpawn(PATH_TO_IMPORT_SCRIPT, [], {
		stdio: 'inherit',
		env: {
			...process.env,
			PGDATABASE: dbName,
		},
	})

	console.info(`\nmarking the import into "${dbName}" as the latest`)
	await client.query(`\
		INSERT INTO latest_import (db_name, always_true)
		VALUES ($1, True)
		ON CONFLICT (always_true) DO UPDATE SET db_name = $1;
	`, [dbName])

	if (PATH_TO_DSN_FILE !== null) {
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
		console.info(`writing "${dsn}" into env file ${PATH_TO_DSN_FILE}`)
		await writeFile(PATH_TO_DSN_FILE, dsn)
	}

	console.info('import succeeded, committing all changes to "latest_import"!')
	await client.query('COMMIT')
} catch (err) {
	console.info('rolling back')
	await client.query('ROLLBACK')
	throw err
}

dbMngmtClient.end()
client.end()
