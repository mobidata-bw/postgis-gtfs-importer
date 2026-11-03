# PostGIS GTFS importer

This tool **imports [GTFS Schedule](https://gtfs.org/schedule/) data into a [PostGIS](https://postgis.net) database using [`gtfs-via-postgres`](https://github.com/public-transport/gtfs-via-postgres)**. It allows running a production service (e.g. an API) from an often-changing GTFS feed by re-importing it without downtime.

Because it works as [atomically](https://en.wikipedia.org/wiki/Atomicity_(database_systems)) as possible with PostgreSQL, it makes the import pipeline *robust*, even if an import fails or if simultaneous imports get started.

The [`ghcr.io/mobidata-bw/postgis-gtfs-importer` Docker image](https://github.com/mobidata-bw/postgis-gtfs-importer/pkgs/container/postgis-gtfs-importer) is built automatically from this repo.

## How it works

First, the GTFS data is downloaded to, unzipped into and [cleaned](https://github.com/public-transport/gtfsclean) within `/tmp/gtfs`; You can specify a custom path using `$GTFS_TMP_DIR`.

The newly downloaded GTFS data will only get imported if it has changed since the last import. This is determined using a [SHA-256 digest](https://en.wikipedia.org/wiki/SHA-2) of the GTFS dataset (and of the post-processing scripts, if configured, see below).

**Each GTFS import runs in a transaction, writing into a temporary schema `GTFS_IMPORTER_SCHEMA_tmp`, which then gets renamed to `$GTFS_IMPORTER_SCHEMA`. It should be safe to abort an import at any time.**

Because `postgis-gtfs-importer` acquires an exclusive [advisory lock](https://www.postgresql.org/docs/16/explicit-locking.html#ADVISORY-LOCKS) on `sha256(gtfs_importer_$GTFS_IMPORTER_SCHEMA)` in the beginning, and aborts if that fails, no more than one import should run in parallel.

As part of the GTFS import, all post-processing scripts in `/etc/gtfs/postprocessing.d` (this path can be changed using `$GTFS_POSTPROCESSING_D_PATH`) will be run, if provided. This way, you can customise or augment the imported data. They are executed within the same transaction as the main GTFS import, so make sure *not to* use transaction commands (`COMMIT`/`ROLLBACK`) in your scripts! Files ending in `.sql` will be run using `psql`, all other files are assumed to be executable scripts. Note that the post-processing scripts also get hashed into the `$sha256_digest`, so if they change, the GTFS data will be imported again.


## Usage

> [!NOTE]
> `postgis-gtfs-importer` currently uses `psql` (PostgreSQL client) v18, so it may not work when used with PostgreSQL servers >18.

### Prerequisites

You can configure access to the DB using the [standard `$PG…` environment variables](https://www.postgresql.org/docs/16/libpq-envars.html).

```shell
export PGDATABASE='…'
export PGUSER='…'
# …
```

> [!IMPORTANT]
> `postgis-gtfs-importer` requires a database user/role that is [allowed](https://www.postgresql.org/docs/16/sql-alterrole.html) to create new schemas (`CREATE` privilege).

### Importing Data

The following commands demonstrate how to use the importer using Docker.

```shell
mkdir gtfs-tmp
docker run --rm -it \
	-v $PWD/gtfs-tmp:/tmp/gtfs \
	-e 'GTFS_DOWNLOAD_USER_AGENT=…' \
	-e 'GTFS_DOWNLOAD_URL=…' \
	-e 'GTFS_IMPORTER_SCHEMA=my_feed' \
	ghcr.io/mobidata-bw/postgis-gtfs-importer:v8
```

> [!TIP]
> To prevent `postgis-gtfs-importer` from re-downloading the GTFS dataset *every time*, even when it hasn't changed, mount a directory at `/tmp/gtfs`.

If you run with `GTFSTIDY_BEFORE_IMPORT=false`, [gtfsclean](https://github.com/public-transport/gtfsclean) (a fork of [gtfstidy](https://github.com/patrickbr/gtfstidy)) will not be used.

You can pass additional options to the underlying [`curl-mirror`](https://gist.github.com/derhuerst/745cf09fe5f3ea2569948dd215bbfe1a) command (and therefore to `curl`) using `$CURL_MIRROR_ADDITIONAL_ARGS`, e.g. to send custom HTTP headers:

```shell
-e 'CURL_MIRROR_ADDITIONAL_ARGS=--header "X-Foo: Bar"'
```

You can pass additional options to the underlying [`gtfs-to-sql`](https://github.com/public-transport/gtfs-via-postgres) command using `$GTFS_TO_SQL_ADDITIONAL_ARGS`, e.g. to import a GTFS feed using [extended route types](https://developers.google.com/transit/gtfs/reference/extended-route-types) (as used e.g. by Swiss GTFS feeds):

```shell
-e 'GTFS_TO_SQL_ADDITIONAL_ARGS=--route-types-scheme google-extended'
```

Keep in mind that `\` characters in `$GTFS_TO_SQL_ADDITIONAL_ARGS` will be interpreted because the variable is processed using Bash's `read` *without* the `-r` flag. For example, setting `GTFS_TO_SQL_ADDITIONAL_ARGS='--foo bar\ baz'` will pass *two* arguments `--foo` & `bar baz` to `gtfs-to-sql`.

### Breaking Changes

A new major version of `postgis-gtfs-importer` *does not* clean up imports done by the previous (major) versions.


## Related

- [duckdb-gtfs-importer](https://github.com/OpenDataVBB/duckdb-gtfs-importer) – Imports GTFS data into a DuckDB database using gtfs-via-duckdb.
