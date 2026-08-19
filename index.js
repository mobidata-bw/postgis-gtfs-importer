import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {spawn} from 'node:child_process'
import {onExit} from 'signal-exit'
import _pg from 'pg'
const {Client} = _pg
import pgFormat from 'pg-format'
import {ok} from 'node:assert'

// Note: We keep compatibility with the "GTFS-RT content negotiation for multiple Schedule feeds" proposal here.
// see also https://gist.github.com/derhuerst/f0b6c9cf28b90746770464eb8e5b918f
// see also https://github.com/public-transport/gtfs-via-postgres/blob/4.12.0/lib/import_metadata.js#L10
const DIGEST_LENGTH = 8

const digestString = (str) => {
	return createHash('sha256')
	.update(str)
	.digest('hex')
	.slice(0, DIGEST_LENGTH)
	.toLowerCase()
}

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

const formatSchemaName = ({schemaNamePrefix, importedAt, feedDigest}) => {
	return [
		schemaNamePrefix,
		importedAt,
		'_',
		feedDigest,
	].join('')
}

const getPgConfig = async (cfg) => {
	const {
		pgHost,
		pgPort,
		pgUser,
		pgPassword,
		pgMetaDatabase,
		pgOpts,
	} = {
		pgHost: null,
		pgPort: null,
		pgUser: null,
		pgPassword: null,
		pgMetaDatabase: null,
		pgOpts: {},
		...cfg,
	}

	const pgConfig = {
		...pgOpts,
	}
	if (pgHost !== null) {
		pgConfig.host = pgHost
	} else if (process.env.PGHOST) {
		pgConfig.host = process.env.PGHOST
	}
	if (pgPort !== null) {
		pgConfig.port = pgPort
	} else if (process.env.PGPORT) {
		pgConfig.port = process.env.PGPORT
	}
	if (pgUser !== null) {
		pgConfig.user = pgUser
	} else if (process.env.PGUSER) {
		pgConfig.user = process.env.PGUSER
	}
	if (pgPassword !== null) {
		pgConfig.password = pgPassword
	} else if (process.env.PGPASSWORD) {
		pgConfig.password = process.env.PGPASSWORD
	}
	if (pgMetaDatabase !== null) {
		pgConfig.database = pgMetaDatabase
	} else if (process.env.PGDATABASE) {
		pgConfig.database = process.env.PGDATABASE
	}

	return pgConfig
}

const connectToDatabase = async (cfg) => {
        const pgConfig = await getPgConfig(cfg)
        const db = new Client(pgConfig)
        await db.connect()

        return db
}

// https://www.postgresql.org/docs/15/libpq-connect.html#id-1.7.3.8.3.5
const getPgEnv = async (pgConfig) => {
	const pgEnv = {
	}

	if (pgConfig.host !== null) {
		pgEnv.PGHOST = pgConfig.host
	}
	if (pgConfig.port !== null) {
		pgEnv.PGPORT = pgConfig.port
	}
	if (pgConfig.user !== null) {
		pgEnv.PGUSER = pgConfig.user
	}
	if (pgConfig.password !== null) {
		pgEnv.PGPASSWORD = pgConfig.password
	}
	if (pgConfig.database !== null) {
		pgEnv.PGDATABASE = pgConfig.database
	}
	// todo: ssl mode?

	return pgConfig
}

const successfulImportsTableName = 'latest_successful_imports_v2'

const ensureSuccesfulImportsTableExists = async (cfg) => {
	const {
		db,
		schemaName,
	} = cfg
	ok(cfg.db, 'missing/empty cfg.db')
	ok(cfg.schemaName, 'missing/empty cfg.schemaName')

	await db.query(pgFormat(`\
		CREATE TABLE IF NOT EXISTS %I.%I (
			schema_name TEXT PRIMARY KEY,
			imported_at INTEGER NOT NULL, -- UNIX timestamp
			feed_digest TEXT NOT NULL
		)
	`, schemaName, successfulImportsTableName))
}

const queryImports = async (cfg) => {
	const {
		db,
		schemaNamePrefix,
	} = cfg
	ok(db, 'missing/empty cfg.db')
	ok(schemaNamePrefix, 'missing/empty cfg.schemaNamePrefix')

	let latestSuccessfulImports = []
	let allSchemas
	try {
		// todo: use pg-format?
		const {
			rows: _rows,
		} = await db.query(`\
			SELECT
				schema_name,
				imported_at,
				feed_digest
			FROM ${successfulImportsTableName}
			WHERE substring(schema_name FOR character_length($1)) = $1
			ORDER BY imported_at DESC
		`, [
			schemaNamePrefix,
		])
		latestSuccessfulImports = _rows.map(row => ({
			schemaName: row.schema_name,
			importedAt: row.imported_at,
			feedDigest: row.feed_digest,
		}))
	} catch (err) {
		if (err.message !== `relation "${successfulImportsTableName}" does not exist`) {
			throw err
		}
	}

	{
		// todo: use pg-format?
		const {
			rows: _rows,
		} = await db.query(`\
			SELECT
				nspname AS schema_name
			FROM pg_namespace
			WHERE substring(nspname FOR character_length($1)) = $1
			ORDER BY nspname ASC
		`, [
			schemaNamePrefix,
		])
		allSchemas = _rows
		.map(row => row.schema_name)
	}

	return {
		latestSuccessfulImports,
		allSchemas,
	}
}

const recordSuccessfulImport = async (cfg) => {
	const {
		db,
		successfulImport: {
			schemaName,
			importedAt,
			feedDigest,
		},
	} = cfg
	ok(db, 'missing/empty cfg.db')
	ok(schemaName, 'missing/empty cfg.successful.schemaName')
	ok(importedAt, 'missing/empty cfg.successful.importedAt')
	ok(feedDigest, 'missing/empty cfg.successful.feedDigest')

	await db.query(
		pgFormat(`\
			INSERT INTO %I (schema_name, imported_at, feed_digest)
			VALUES ($1, $2, $3)
		`, successfulImportsTableName),
		[
			schemaName,
			importedAt,
			feedDigest,
		],
	)
}

const removeImportFromLatestSuccessfulImports = async (cfg) => {
	const {
		db,
		schemaName,
	} = cfg
	ok(db, 'missing/empty cfg.db')
	ok(schemaName, 'missing/empty cfg.schemaName')

	await db.query(
		pgFormat(`\
			DELETE FROM %I
			WHERE schema_name = $1
		`, successfulImportsTableName),
		[
			schemaName,
		],
	)
}

export {
	digestString,
	digestFile,
	pSpawn,
	formatSchemaName,
	getPgEnv,
	getPgConfig,
	connectToDatabase,
	successfulImportsTableName,
	ensureSuccesfulImportsTableExists,
	queryImports,
	recordSuccessfulImport,
	removeImportFromLatestSuccessfulImports,
}
