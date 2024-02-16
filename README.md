# PostGIS GTFS importer

This tool **imports [GTFS Schedule](https://gtfs.org/schedule/) data into a [PostGIS](https://postgis.net) database using [`gtfs-via-postgres`](https://github.com/public-transport/gtfs-via-postgres)**. By working as [atomically](https://en.wikipedia.org/wiki/Atomicity_(database_systems)) as possible with PostgreSQL, it allows production systems to periodically import the latest GTFS data automatically in a *robust* way.

The [`ghcr.io/mobidata-bw/postgis-gtfs-importer` Docker image](https://github.com/mobidata-bw/postgis-gtfs-importer/pkgs/container/postgis-gtfs-importer) is built automatically from this repo.

## How it works

First, the GTFS data is downloaded to, unzipped into and [tidied](https://github.com/patrickbr/gtfstidy) within `/tmp/gtfs`; You can specify a custom path using `$GTFS_TMP_DIR`.

**Each GTFS import gets its own PostgreSQL database** called `$GTFS_IMPORTER_DB_PREFIX_$unix_timestamp`. The importer keeps track of the latest import by – once an import has succeeded – writing its DB name into a table `latest_import` within a "meta bookkeeping database".

Before each import, it also **deletes all imports but the most recent two**; This ensures that your disk won't overflow but that a rollback to the previous import is always possible.

Because the entire import script runs in a [transaction](https://www.postgresql.org/docs/14/tutorial-transactions.html), and because it acquires an exclusive lock on on `latest_import` in the beginning, it **should be safe to abort an import at any time**, or to (accidentally) run more than one process in parallel. Because creating and deleting DBs is *not* possible within a transaction, the importer opens a separate DB connection to do that; Therefore, aborting an import might leave an empty DB (not marked as the latest yet), which will be cleaned up before the next import (see above).

After the actual import, it will run all SQL post-processing scripts in `/etc/gtfs/sql.d` (this path can be changed using `$GTFS_SQL_D_PATH`), if provided. This way, you can customise or augment the imported data.


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
