#!/usr/bin/env bash
set -e
set -u
set -E # abort if subshells fail
set -o pipefail

source "$(dirname "$(realpath "$0")")/lib.sh"

gtfs_path=''

sql_d_path="${GTFS_SQL_D_PATH:-/etc/gtfs/sql.d}"

print_bold "Extracting the GTFS feed."
set -x

rm -rf "$extracted_path"
unzip -d "$extracted_path" "$zip_path"
gtfs_path="$extracted_path"

if [[ -f '/etc/gtfs/preprocess.sh' ]]; then
	set +x
	print_bold "Preprocessing GTFS feed using preprocess.sh."
	set -x
	/etc/gtfs/preprocess.sh "$gtfs_path"
fi

if [ "${GTFSTIDY_BEFORE_IMPORT:-true}" != false ]; then
	set +x
	print_bold "Tidying GTFS feed using gtfstidy."
	set -x

	# Remove any leftovers from previous runs (e.g. pathways.txt/levels.txt)
	rm -rf "$tidied_path"
	# Instead of --Compress, which is shorthand for -OSRCcIAPdT, we use --OSRCcIAPT (no id minimisation)
	# Note: in later versions of gtfstidy, --keep-ids and --keep-additional-fields are introduced
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

set +x
print_bold "Importing GTFS feed into the $PGDATABASE database."
set -x

gtfs-to-sql --version

gtfs-to-sql -d \
	--trips-without-shape-id --lower-case-lang-codes \
	--stops-location-index \
	--import-metadata \
	--schema api --postgrest \
	"$gtfs_path/"*.txt \
	| zstd | sponge | zstd -d \
	| psql -b -v 'ON_ERROR_STOP=1'

if [ -d "$sql_d_path" ]; then
	set +x
	print_bold "Running custom post-processing SQL scripts in $sql_d_path."
	set -x
	for file in "$sql_d_path/"*; do
		psql -b -1 -v 'ON_ERROR_STOP=1' -f "$file"
	done
fi

set +x
print_bold 'Done!'
