# PostGIS GTFS importer

From this repo, the [`ghcr.io/mobidata-bw/postgis-gtfs-importer` Docker image](https://github.com/mobidata-bw/postgis-gtfs-importer/pkgs/container/postgis-gtfs-importer) is built, which **imports [GTFS Schedule](https://gtfs.org/schedule/) data into a [PostGIS](https://www.postgis.net) database using [gtfs-via-postgres](https://github.com/public-transport/gtfs-via-postgres)**.

## How it works

The importer uses [gtfstidy](https://github.com/patrickbr/gtfstidy) to clean up the GTFS dataset before importing it.

By default, the GTFS data is downloaded to, unzipped into and tidied in `/tmp/gtfs`, but you can specify a custom path using `$GTFS_TMP_DIR`.

**Each GTFS import gets its own PostgreSQL database** called `$GTFS_IMPORTER_DB_PREFIX_$unix_timestamp`. The importer keeps track of all databases with this naming schema in a "meta table" `latest_import` in a "meta database"; After a successful import, **deletes all of them but the most recent two**; This ensures that your disk won't overflow but that a rollback to the previous import is always possible.

Because the entire import script runs in a [transaction](https://www.postgresql.org/docs/14/tutorial-transactions.html) and acquires an exclusive lock on on `latest_import` in the beginning, it should be safe to cancel an import at any time, or to (accidentally) run more than one process in parallel.

After the import, it will run all SQL post-processing scripts in `/etc/gtfs/sql.d` (this path can be changed using `$GTFS_SQL_D_PATH`), if provided. This way, you can customise or augment the imported data.


## Usage

The following commands demonstrate how to use the importer using Docker.

```shell
mkdir gtfs-tmp
docker run --rm -it \
	-v $PWD/gtfs-tmp:/tmp/gtfs \
	-e 'GTFS_DOWNLOAD_USER_AGENT=…' \
	-e 'GTFS_DOWNLOAD_URL=…' \
	ghcr.io/mobidata-bw/postgis-gtfs-importer
```

*Note:* We mount a `gtfs-tmp` directory to prevent it from re-downloading the GTFS dataset every time, even when it hasn't changed.

You can configure access to the PostgreSQL by passing the [standard `PG*` environment variables](https://www.postgresql.org/docs/14/libpq-envars.html) into the container.

### writing a DSN file

If you set `$PATH_TO_DSN_FILE` to a file path, the importer will also write a [PostgreSQL key/value connection string (DSN)](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING-KEYWORD-VALUE) to that path. Note that you must also provide `$POSTGREST_USER` & `$POSTGREST_PASSWORD` in this case.

This feature is intended to be used with [PgBouncer](https://pgbouncer.org) for "dynamic" routing of PostgreSQL clients to the database containing the latest GTFS import.
