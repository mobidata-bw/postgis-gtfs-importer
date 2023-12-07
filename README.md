# PostGIS GTFS importer

From this repo, the [`ghcr.io/mobidata-bw/postgis-gtfs-importer` Docker image](https://github.com/mobidata-bw/postgis-gtfs-importer/pkgs/container/postgis-gtfs-importer) is built, which **imports [GTFS Schedule](https://gtfs.org/schedule/) data into a [PostGIS](https://www.postgis.net) database using [gtfs-via-postgres](https://github.com/public-transport/gtfs-via-postgres)**.

## How it works

The importer uses [gtfstidy](https://github.com/patrickbr/gtfstidy) to clean up the GTFS dataset before importing it.

By default, the GTFS data is downloaded to, unzipped into and tidied in `/tmp/gtfs`, but you can specify a custom path using `$GTFS_TMP_DIR`.

**Each GTFS import gets its own PostgreSQL database** called `$GTFS_IMPORTER_DB_PREFIX_$unix_timestamp`. The importer keeps track of all databases with this naming schema in a "meta table" `latest_import` in a "meta database"; After a successful import, **deletes all of them but the most recent two**; This ensures that your disk won't overflow but that a rollback to the previous import is always possible.

Because the entire import script runs in a [transaction](https://www.postgresql.org/docs/14/tutorial-transactions.html) and acquires an exclusive lock on on `latest_import` in the beginning, it should be safe to cancel an import at any time, or to (accidentally) run more than one process in parallel.

After the import, it will run all SQL post-processing scripts in `/etc/gtfs/sql.d`, if provided. This way, you can customise the imported data.
