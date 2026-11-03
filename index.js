import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {spawn} from 'node:child_process'
import {onExit} from 'signal-exit'
import _pg from 'pg'
const {Client} = _pg
import pgFormat from 'pg-format'
import {ok} from 'node:assert'

// > 3F000 – invalid_schema_name
const PG_ERROR_INVALID_SCHEMA_NAME = '3F000'
// > 42883 – undefined_function
const PG_ERROR_UNDEFINED_FUNCTION = '42883'

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

const queryPreviousImport = async (cfg) => {
	const {
		db,
		schemaName,
	} = cfg
	ok(db, 'missing/empty cfg.db')
	ok(schemaName, 'missing/empty cfg.schemaName')

	try {
		const {
			rows: [{
				imported_at: importedAt,
				feed_digest: feedDigest,
			}],
		} = await db.query(
			pgFormat(`\
				SELECT
					%I.gtfs_data_imported_at () AS imported_at,
					%I.gtfs_feed_digest () AS feed_digest
			`, schemaName, schemaName),
		)
		return {
			importedAt,
			feedDigest,
		}
	} catch (err) {
		// If the schema or function does not exist, no import has been done, so we can continue.
		if (
			err.code === PG_ERROR_INVALID_SCHEMA_NAME
			|| err.code === PG_ERROR_UNDEFINED_FUNCTION
		) {
			return null
		}
		throw err
	}
}

export {
	digestString,
	digestFile,
	pSpawn,
	getPgEnv,
	getPgConfig,
	connectToDatabase,
	queryPreviousImport,
}
