import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {spawn} from 'node:child_process'
import {onExit} from 'signal-exit'
import _pg from 'pg'
const {Client} = _pg
import pgFormat from 'pg-format'
import {ok} from 'node:assert'

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

const formatDbName = ({databaseNamePrefix, importedAt, zipDigest}) => {
	return [
		databaseNamePrefix,
		importedAt,
		'_',
		zipDigest,
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

const connectToMetaDatabase = async (cfg) => {
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

const successfulImportsTableName = 'latest_successful_imports'

const ensureSuccesfulImportsTableExists = async (cfg) => {
	const {
		db,
	} = cfg
	ok(cfg.db, 'missing/empty cfg.db')

	await db.query(`\
		CREATE TABLE IF NOT EXISTS ${successfulImportsTableName} (
			db_name TEXT PRIMARY KEY,
			imported_at INTEGER NOT NULL, -- UNIX timestamp
			feed_digest TEXT NOT NULL
		)
	`)
}

const queryImports = async (cfg) => {
	const {
		databaseNamePrefix,
	} = cfg
	ok(databaseNamePrefix, 'missing/empty cfg.databaseNamePrefix')
	let db
	if ('db' in cfg) {
		ok(cfg.db, 'missing/empty cfg.db')
		db = cfg.db
	} else {
		db = await connectToMetaDatabase(cfg)
	}

	let latestSuccessfulImports = []
	let allDbs = []
	try {
		// todo: use pg-format?
		const {
			rows: _rows,
		} = await db.query(`\
			SELECT
				db_name,
				imported_at,
				feed_digest
			FROM ${successfulImportsTableName}
			WHERE substring(db_name FOR character_length($1)) = $1
			ORDER BY imported_at DESC
		`, [
			databaseNamePrefix,
		])
		latestSuccessfulImports = _rows.map(row => ({
			// todo [breaking]: rename to `dbName`
			name: row.db_name,
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
				datname AS db_name
			FROM pg_catalog.pg_database
			WHERE substring(datname FOR character_length($1)) = $1
			ORDER BY datname ASC
		`, [
			databaseNamePrefix,
		])
		allDbs = _rows
		.map(row => row.db_name)
		.filter(dbName => dbName !== db.database) // omit meta "bookkeeping" database
	}

	return {
		latestSuccessfulImports,
		allDbs,
	}
}

const recordSuccessfulImport = async (cfg) => {
	const {
		db,
		successfulImport: {
			dbName,
			importedAt,
			feedDigest,
		},
	} = cfg
	ok(db, 'missing/empty cfg.db')
	ok(dbName, 'missing/empty cfg.successful.dbName')
	ok(importedAt, 'missing/empty cfg.successful.importedAt')
	ok(feedDigest, 'missing/empty cfg.successful.feedDigest')

	await db.query(
		pgFormat(`\
			INSERT INTO %I (db_name, imported_at, feed_digest)
			VALUES ($1, $2, $3)
		`, successfulImportsTableName),
		[
			dbName,
			importedAt,
			feedDigest,
		],
	)
}

const removeDbFromLatestSuccessfulImports = async (cfg) => {
	const {
		db,
		dbName,
	} = cfg
	ok(db, 'missing/empty cfg.db')
	ok(dbName, 'missing/empty cfg.dbName')

	await db.query(
		pgFormat(`\
			DELETE FROM %I
			WHERE db_name = $1
		`, successfulImportsTableName),
		[
			dbName,
		],
	)
}

export {
	digestFile,
	pSpawn,
	formatDbName,
	getPgEnv,
	getPgConfig,
	connectToMetaDatabase,
	successfulImportsTableName,
	ensureSuccesfulImportsTableExists,
	queryImports,
	recordSuccessfulImport,
	removeDbFromLatestSuccessfulImports,
}
