#!/usr/bin/env node

import {importGtfsAtomically} from './import.js'

const GTFS_DOWNLOAD_USER_AGENT = process.env.GTFS_DOWNLOAD_USER_AGENT
if (!GTFS_DOWNLOAD_USER_AGENT) {
	console.error('Missing/empty $GTFS_DOWNLOAD_USER_AGENT.')
	process.exit(1)
}
const GTFS_DOWNLOAD_URL = process.env.GTFS_DOWNLOAD_URL
if (!GTFS_DOWNLOAD_URL) {
	console.error('Missing/empty $GTFS_DOWNLOAD_URL.')
	process.exit(1)
}

await importGtfsAtomically({
	gtfsDownloadUserAgent: GTFS_DOWNLOAD_USER_AGENT,
	gtfsDownloadUrl: GTFS_DOWNLOAD_URL,
})
