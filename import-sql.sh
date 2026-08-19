#!/usr/bin/env bash
set -e
set -u
set -E # abort if subshells fail
set -o pipefail

source "$(dirname "$(realpath "$0")")/lib.sh"

gtfs_path="${gtfs_path:?missing/empty}"

postprocessing_d_path="${GTFS_POSTPROCESSING_D_PATH:?missing/empty}"

db_schema="${GTFS_IMPORTER_SCHEMA:?missing/empty}"

if [ "$verbose" != false ]; then
	set -x # enable xtrace
fi

gtfs_to_sql_args=()
if [ "$verbose" = false ]; then
	gtfs_to_sql_args+=('--silent')
fi
# e.g. GTFS_TO_SQL_ADDITIONAL_ARGS='--route-types-scheme google-extended' for Swiss GTFS feeds
read -a gtfs_to_sql_additional_args <<< "${GTFS_TO_SQL_ADDITIONAL_ARGS:-}"

echo "CREATE SCHEMA \"$db_schema\";"

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
			psql -b -1 -v 'ON_ERROR_STOP=1' --set=SHELL="$SHELL" "${psql_args[@]}" \
				-f "$file"
		else
			"$file" "$gtfs_path"
		fi
	done
	# reset `nullglob` to previous setting
	eval "$prev_nullglob"
fi
