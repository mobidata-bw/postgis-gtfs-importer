import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {spawn} from 'node:child_process'
import {onExit} from 'signal-exit'
import _pg from 'pg'
const {Client} = _pg
import {deepStrictEqual, ok} from 'node:assert'

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

const readImportedDatabases = async (cfg) => {
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

	let prevImport = null
	let oldDbs = []
	try {
		const {
			rows: [{
				db_name: _prevImportName,
			}],
		} = await db.query('SELECT db_name FROM latest_import')
		prevImport = _prevImportName
			? parseDbName(_prevImportName, databaseNamePrefix)
			: null
	} catch (err) {
		if (err.message === 'relation "latest_import" does not exist') {
			return {
				prevImport,
				oldDbs,
			}
		}
		throw err
	}

	const {
		rows: _oldDbs,
	} = await db.query(`\
		SELECT datname AS db_name
		FROM pg_catalog.pg_database
		ORDER BY datname ASC
	`)
	oldDbs = _oldDbs
	.map(r => parseDbName(r.db_name, databaseNamePrefix))
	.filter(parsed => Boolean(parsed))

	return {
		prevImport,
		oldDbs,
	}
}

export {
	digestFile,
	pSpawn,
	formatDbName,
	parseDbName,
	getPgEnv,
	getPgConfig,
	connectToMetaDatabase,
	readImportedDatabases,
}
