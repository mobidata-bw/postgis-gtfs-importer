#!/usr/bin/env bash
set -e
set -u
set -E # abort if subshells fail
set -o pipefail

source "$(dirname "$(realpath "$0")")/lib.sh"

gtfs_path="${gtfs_path:?missing/empty}"

postprocessing_d_path="${GTFS_POSTPROCESSING_D_PATH:?missing/empty}"

db_schema="${GTFS_IMPORTER_SCHEMA:?missing/empty}"
final_db_schema="${GTFS_IMPORTER_FINAL_DB_SCHEMA:?missing/empty}"

if [ "$verbose" != false ]; then
	set -x # enable xtrace
fi

gtfs_to_sql_args=()
if [ "$verbose" = false ]; then
	gtfs_to_sql_args+=('--silent')
fi
# e.g. GTFS_TO_SQL_ADDITIONAL_ARGS='--route-types-scheme google-extended' for Swiss GTFS feeds
read -a gtfs_to_sql_additional_args <<< "${GTFS_TO_SQL_ADDITIONAL_ARGS:-}"

echo "-- postgis-gtfs-importer header"
echo 'BEGIN;'

# gtfs-via-postgres just generates SQL `CREATE EXTENSION […] postgis` (as of v4.12). Because this SQL statement runs with our custom schema in `search_path` (see below), PostGIS' objects won't be "global". This causes subsequent imports to fail on statements refencing PostGIS types (with `ERROR: type "geography" does not exist`).
# As a workaround, we manually install the `postgis` extension here, "globally", i.e. outside of our custom schema.
echo 'CREATE EXTENSION IF NOT EXISTS postgis;'

echo 'SHOW search_path;' # todo: remove debugging

echo "CREATE SCHEMA \"$db_schema\";"

# In contrast to *overwriting*, *extending* a parameter seems impossible using `SET`, so we use `UPDATE pg_settings` with a CTE.
echo "WITH t AS (SELECT setting AS old_search_path FROM pg_settings WHERE name = 'search_path') UPDATE pg_settings SET setting = '\"$db_schema\",' || old_search_path FROM t WHERE name = 'search_path';"

echo -e "\n\n\n"

# Note: We need --import-metadata (and therefore $GTFS_FEED_DIGEST) so that postgis-gtfs-importer, in a second invocation, can read this import's feed digest.
: "${GTFS_FEED_DIGEST:?empty}" # assert that $GTFS_FEED_DIGEST is non-empty
gtfs-to-sql -d "${gtfs_to_sql_args[@]}" \
	--trips-without-shape-id --lower-case-lang-codes \
	--stops-location-index \
	--import-metadata \
	--schema "$db_schema" \
	--no-transaction \
	--postgrest \
	"${gtfs_to_sql_additional_args[@]}" \
	"$gtfs_path/"*.txt

if [ -d "$postprocessing_d_path" ]; then
	# Bash exits with `1` if the option is currently not set.
	prev_nullglob="$(shopt -p nullglob || true)"
	shopt -s nullglob
	# todo: DRY this with the hash calculation in import.js
	for file in "$postprocessing_d_path/"*; do
		echo -e "-- custom post-processing script $file.\n"
		ext="${file##*.}"
		if [ "$ext" = "sql" ]; then
			cat "$file"
		else
			"$file" "$gtfs_path"
		fi
	done
	# reset `nullglob` to previous setting
	eval "$prev_nullglob"
fi

echo -e "\n\n\n-- postgis-gtfs-importer footer"
echo "DROP SCHEMA IF EXISTS \"$final_db_schema\" CASCADE;"
echo "ALTER SCHEMA \"$db_schema\" RENAME TO \"$final_db_schema\";"
echo 'SET search_path TO DEFAULT;'
echo 'COMMIT;'
