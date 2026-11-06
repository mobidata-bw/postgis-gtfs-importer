import {fileURLToPath} from 'node:url'
import {ok} from 'node:assert'
import {
	readdir,
} from 'node:fs/promises'
import {
	digestString,
	digestFile,
	pSpawn,
	getPgConfig,
	getPgEnv,
	connectToDatabase,
	queryPreviousImport,
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
		schemaName, // todo: rename to `metaSchemaName`?
		pathToImportScript,
		pathToDownloadScript,
		pathToPostImportScript,
		gtfsDownloadUrl,
		gtfsDownloadUserAgent,
		tmpDir,
		gtfstidyBeforeImport,
		gtfsPostprocessingDPath,
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
		gtfsDownloadUrl: null,
		gtfsDownloadUserAgent: null,
		tmpDir: process.env.GTFS_TMP_DIR || '/tmp/gtfs',
		gtfstidyBeforeImport: null, // or `true` or `false`
		gtfsPostprocessingDPath: process.env.GTFS_POSTPROCESSING_D_PATH || '/etc/gtfs/postprocessing.d',
		...cfg,
	}
	ok(schemaName, 'missing/empty cfg.schemaName')
	ok(pathToImportScript, 'missing/empty cfg.pathToImportScript')
	ok(pathToDownloadScript, 'missing/empty cfg.pathToDownloadScript')
	ok(pathToPostImportScript, 'missing/empty cfg.pathPostToImportScript')
	ok(gtfsDownloadUrl, 'missing/empty cfg.gtfsDownloadUrl')
	ok(gtfsDownloadUserAgent, 'missing/empty cfg.gtfsDownloadUserAgent')

	// todo: debug-log current git ref

	const result = {
		downloadDurationMs: null,
		// deletedSchemas: [], // [schemaName]
		// retainedSchemas: null, // [schemaName]
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

	const client = await connectToDatabase(cfg)

	await client.query('BEGIN')
	try {
		const lockId = digestString('gtfs_importer_' + schemaName)
		logger.info(`obtaining exclusive advisory lock on ${lockId}, so that only one import can be running`)
		const {
			rows: [{
				lock_acquired,
			}],
		} = await client.query(
			'SELECT pg_try_advisory_xact_lock($1) AS lock_acquired',
			[
				'0x' + lockId,
			],
		)
		if (!lock_acquired) {
			logger.warn(`failed to acquire exclude advisory lock on ${lockId}, aborting`)
			return result
		}

		logger.debug(`trying to read the previous import's metadata`)
		const prevImport = await queryPreviousImport({
			db: client,
			schemaName,
		})
		if (!prevImport) {
			logger.debug(`no previous import found in "${schemaName}"`)
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

		logger.info(`import succeeded, committing transaction!`)
		// releases the lock on $schemaName.stops
		await client.query('COMMIT')
		logger.info('import finished')
	} catch (err) {
		logger.warn('an error occured')
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
