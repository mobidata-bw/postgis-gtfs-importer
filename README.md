# PostGIS GTFS importer

This tool **imports [GTFS Schedule](https://gtfs.org/schedule/) data into a [PostGIS](https://postgis.net) database using [`gtfs-via-postgres`](https://github.com/public-transport/gtfs-via-postgres)**. It allows running a production service (e.g. an API) on top of programmatically re-imported data from a periodically changing GTFS feed without downtime.

Because it works as [atomically](https://en.wikipedia.org/wiki/Atomicity_(database_systems)) as possible with PostgreSQL, it makes the import pipeline *robust*, even if an import fails or if simultaneous imports get started.

The [`ghcr.io/mobidata-bw/postgis-gtfs-importer` Docker image](https://github.com/mobidata-bw/postgis-gtfs-importer/pkgs/container/postgis-gtfs-importer) is built automatically from this repo.

## How it works

First, the GTFS data is downloaded to, unzipped into and [tidied](https://github.com/patrickbr/gtfstidy) within `/tmp/gtfs`; You can specify a custom path using `$GTFS_TMP_DIR`.

**Each GTFS import gets its own PostgreSQL database** called `$GTFS_IMPORTER_DB_PREFIX_$unix_timestamp_$sha256_digest`. The importer keeps track of the latest import by – once an import has succeeded – writing the import's DB name into a table `latest_import` within a "meta bookkeeping database".

The newly downloaded GTFS data will only get imported if it has changed since the last import. This is determined using the [SHA-256 digest](https://en.wikipedia.org/wiki/SHA-2).

Before each import, it also **deletes all imports but the most recent two**; This ensures that your disk won't overflow but that a rollback to the previous import is always possible.

Because the entire import script runs in a [transaction](https://www.postgresql.org/docs/14/tutorial-transactions.html), and because it acquires an exclusive [lock](https://www.postgresql.org/docs/14/explicit-locking.html) on on `latest_import` in the beginning, it **should be safe to abort an import at any time**, or to (accidentally) run more than one process in parallel. Because creating and deleting DBs is *not* possible within a transaction, the importer opens a separate DB connection to do that; Therefore, aborting an import might leave an empty DB (not marked as the latest yet), which will be cleaned up as part of the next import (see above).

After the GTFS has been imported but before the import is marked as successful, it will run all post-processing scripts in `/etc/gtfs/postprocessing.d` (this path can be changed using `$GTFS_POSTPROCESSING_D_PATH`), if provided. This way, you can customise or augment the imported data. The execution of these scripts happens within the same transaction (in the bookkeeping DB) as the GTFS import. Files ending in `.sql` will be run using `psql`, all other files are assumed executable scripts.


## Usage

### Prerequisites

You can configure access to the bookkeeping DB using the [standard `$PG…` environment variables](https://www.postgresql.org/docs/14/libpq-envars.html).

```shell
export PGDATABASE='…'
export PGUSER='…'
# …
```

*Note:* `postgis-gtfs-importer` requires a database user/role that is [allowed](https://www.postgresql.org/docs/14/sql-alterrole.html) to create new databases (`CREATEDB` privilege).

### Importing Data

The following commands demonstrate how to use the importer using Docker.

```shell
mkdir gtfs-tmp
docker run --rm -it \
	-v $PWD/gtfs-tmp:/tmp/gtfs \
	-e 'GTFS_DOWNLOAD_USER_AGENT=…' \
	-e 'GTFS_DOWNLOAD_URL=…' \
	ghcr.io/mobidata-bw/postgis-gtfs-importer:v4
```

*Note:* We mount a `gtfs-tmp` directory to prevent it from re-downloading the GTFS dataset every time, even when it hasn't changed.

You can configure access to the PostgreSQL by passing the [standard `PG*` environment variables](https://www.postgresql.org/docs/14/libpq-envars.html) into the container.

If you run with `GTFSTIDY_BEFORE_IMPORT=false`, gtfstidy will not be used.

### writing a DSN file

If you set `$PATH_TO_DSN_FILE` to a file path, the importer will also write a [PostgreSQL key/value connection string (DSN)](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING-KEYWORD-VALUE) to that path. Note that you must also provide `$POSTGREST_USER` & `$POSTGREST_PASSWORD` in this case.

This feature is intended to be used with [PgBouncer](https://pgbouncer.org) for "dynamic" routing of PostgreSQL clients to the database containing the latest GTFS import.

### Breaking Changes

A new major version of `postgis-gtfs-importer` *does not* clean up imports done by the previous (major) versions.
