#!/usr/bin/env bash
set -e
set -u
set -E # abort if subshells fail
set -o pipefail

source "$(dirname "$(realpath "$0")")/lib.sh"

gtfs_path=''

sql_d_path="${GTFS_SQL_D_PATH:-/etc/gtfs/sql.d}"

verbose="${GTFS_IMPORTER_VERBOSE:-true}"
if [ "$verbose" != false ]; then
	set -x # enable xtrace
fi

print_bold "Extracting the GTFS feed."

rm -rf "$extracted_path"

unzip_args=()
if [ "$verbose" = false ]; then
	unzip_args+=('-q')
fi
unzip "${unzip_args[@]}" \
	-d "$extracted_path" \
	"$zip_path"

gtfs_path="$extracted_path"

if [[ -f '/etc/gtfs/preprocess.sh' ]]; then
	print_bold "Preprocessing GTFS feed using preprocess.sh."
	/etc/gtfs/preprocess.sh "$gtfs_path"
fi

if [ "${GTFSTIDY_BEFORE_IMPORT:-true}" != false ]; then
	print_bold "Tidying GTFS feed using gtfstidy."

	# Remove any leftovers from previous runs (e.g. pathways.txt/levels.txt)
	rm -rf "$tidied_path"
	# Instead of --Compress, which is shorthand for -OSRCcIAPdT, we use --OSRCcIAPT (no id minimisation)
	# Note: in later versions of gtfstidy, --keep-ids and --keep-additional-fields are introduced
	# todo: if `$verbose != false`, somehow make gtfstidy less verbose
	gtfstidy \
		--show-warnings \
		-OSRCcIAPT \
		--fix \
		--min-shapes \
		-o "$tidied_path" \
		"$gtfs_path" \
		2>&1 | tee "$gtfs_tmp_dir/tidied.gtfs.gtfstidy-log.txt"
	gtfs_path="$tidied_path"
fi

print_bold "Importing GTFS feed into the $PGDATABASE database."

gtfs-to-sql --version

psql_args=()
gtfs_to_sql_args=()
if [ "$verbose" = false ]; then
	psql_args+=('--quiet')
	gtfs_to_sql_args+=('--silent')
fi

gtfs-to-sql -d "${gtfs_to_sql_args[@]}" \
	--trips-without-shape-id --lower-case-lang-codes \
	--stops-location-index \
	--import-metadata \
	--schema "${GTFS_IMPORTER_SCHEMA:-api}" \
	--postgrest \
	"$gtfs_path/"*.txt \
	| zstd | sponge | zstd -d \
	| psql -b -v 'ON_ERROR_STOP=1' "${psql_args[@]}"

if [ -d "$sql_d_path" ]; then
	print_bold "Running custom post-processing SQL scripts in $sql_d_path."
	for file in "$sql_d_path/"*; do
		psql -b -1 -v 'ON_ERROR_STOP=1' "${psql_args[@]}" \
			-f "$file"
	done
fi

print_bold 'Done!'
