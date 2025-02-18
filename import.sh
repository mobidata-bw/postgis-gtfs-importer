#!/usr/bin/env bash
set -e
set -u
set -E # abort if subshells fail
set -o pipefail

source "$(dirname "$(realpath "$0")")/lib.sh"

gtfs_path=''

postprocessing_d_path="${GTFS_POSTPROCESSING_D_PATH:?missing/empty}"

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

	set +x
	gtfstidy_args=()
	if [ "$verbose" != false ]; then
		gtfstidy_args+=('--show-warnings')
	fi

	# fixing
	if [ "${GTFSTIDY_FIX_ZIP:-true}" != false ]; then
		gtfstidy_args+=('--fix-zip') # -z
	fi
	if [ "${GTFSTIDY_DEFAULT_ON_ERRS:-true}" != false ]; then
		gtfstidy_args+=('--default-on-errs') # -e
	fi
	if [ "${GTFSTIDY_DROP_ERRS:-true}" != false ]; then
		gtfstidy_args+=('--drop-errs') # -D
	fi
	if [ "${GTFSTIDY_CHECK_NULL_COORDS:-true}" != false ]; then
		gtfstidy_args+=('--check-null-coords') # -n
	fi

	# minimization
	# Note: In later versions of gtfstidy, --keep-ids and --keep-additional-fields will be introduced.
	if [ "${GTFSTIDY_MIN_SHAPES:-true}" != false ]; then
		gtfstidy_args+=('--min-shapes') # -s
	fi
	if [ "${GTFSTIDY_MINIMIZE_SERVICES:-true}" != false ]; then
		gtfstidy_args+=('--minimize-services') # -c
	fi
	if [ "${GTFSTIDY_MINIMIZE_STOPTIMES:-true}" != false ]; then
		gtfstidy_args+=('--minimize-stoptimes') # -T
	fi
	if [ "${GTFSTIDY_DELETE_ORPHANS:-true}" != false ]; then
		gtfstidy_args+=('--delete-orphans') # -O
	fi
	if [ "${GTFSTIDY_REMOVE_REDUNDANT_AGENCIES:-true}" != false ]; then
		gtfstidy_args+=('--remove-red-agencies') # -A
	fi
	if [ "${GTFSTIDY_REMOVE_REDUNDANT_ROUTES:-true}" != false ]; then
		gtfstidy_args+=('--remove-red-routes') # -R
	fi
	if [ "${GTFSTIDY_REMOVE_REDUNDANT_SERVICES:-true}" != false ]; then
		gtfstidy_args+=('--remove-red-services') # -C
	fi
	if [ "${GTFSTIDY_REMOVE_REDUNDANT_SHAPES:-true}" != false ]; then
		gtfstidy_args+=('--remove-red-shapes') # -S
	fi
	if [ "${GTFSTIDY_REMOVE_REDUNDANT_STOPS:-true}" != false ]; then
		gtfstidy_args+=('--remove-red-stops') # -P
	fi
	if [ "${GTFSTIDY_REMOVE_REDUNDANT_TRIPS:-true}" != false ]; then
		gtfstidy_args+=('--remove-red-trips') # -I
	fi

	# todo: allow configuring additional flags
	set -x

	gtfstidy \
		"${gtfstidy_args[@]}" \
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
	--schema "${GTFS_IMPORTER_SCHEMA:-public}" \
	--postgrest \
	"$gtfs_path/"*.txt \
	| zstd | sponge | zstd -d \
	| psql -b -v 'ON_ERROR_STOP=1' "${psql_args[@]}"

if [ -d "$postprocessing_d_path" ]; then
	print_bold "Running custom post-processing scripts in $postprocessing_d_path."
	shopt -s nullglob
	for file in "$postprocessing_d_path/"*; do
		ext="${file##*.}"
		if [ "$ext" = "sql" ]; then
			psql -b -1 -v 'ON_ERROR_STOP=1' --set=SHELL="$SHELL" "${psql_args[@]}" \
				-f "$file"
		else
			"$file" "$gtfs_path"
		fi
	done
	shopt -u nullglob
fi

print_bold 'Done!'
