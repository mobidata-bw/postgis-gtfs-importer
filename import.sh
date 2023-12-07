#!/usr/bin/env bash
set -e
set -E # abort if subshells fail
set -o pipefail

print_bold () {
	if [ -t 0 ]; then
		echo "$(tput bold)$1$(tput sgr0)"
	else
		echo "$1"
	fi
}

ua="${GTFS_DOWNLOAD_USER_AGENT:-IPL (MobiData-BW)}"
bwgesamt='https://www.nvbw.de/fileadmin/user_upload/service/open_data/fahrplandaten_mit_liniennetz/bwgesamt.zip'
gtfs_url="${GTFS_DOWNLOAD_URL:-$bwgesamt}"
gtfs_tmp_dir="${GTFS_TMP_DIR:-/tmp/gtfs}"
mkdir -p "$gtfs_tmp_dir"

zip_path="$gtfs_tmp_dir/gtfs.zip"
extracted_path="$gtfs_tmp_dir/gtfs"
tidied_path="$gtfs_tmp_dir/tidied.gtfs"

print_bold "Downloading & extracting the GTFS feed from $GTFS_DOWNLOAD_URL."
set -x

# custom curl-based HTTP mirroring/download script
# > curl-mirror [--tmp-prefix …] [--log-level …] [--debug-curl] <url> <dest-path> [-- curl-opts...]
# see https://gist.github.com/derhuerst/745cf09fe5f3ea2569948dd215bbfe1a
curl-mirror \
	--tmp-prefix "$zip_path.mirror-" \
	"$gtfs_url" "$zip_path" \
	-- \
	-H "User-Agent: $ua"

rm -rf "$extracted_path"
unzip -d "$extracted_path" "$zip_path"

set +x
print_bold "Tidying GTFS feed using preprocess.sh & gtfstidy."
set -x

if [[ -f '/etc/gtfs/preprocess.sh' ]]; then
	/etc/gtfs/preprocess.sh "$extracted_path"
fi

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
	"$extracted_path" \
	2>&1 | tee "$gtfs_tmp_dir/tidied.gtfs.gtfstidy-log.txt"

set +x
print_bold "Importing (tidied) GTFS feed into the $PGDATABASE database."
set -x

gtfs-to-sql --version

gtfs-to-sql -d \
	--trips-without-shape-id --lower-case-lang-codes \
	--stops-location-index \
	--import-metadata \
	--schema api --postgrest \
	"$tidied_path/"*.txt \
	| zstd | sponge | zstd -d \
	| psql -b -v 'ON_ERROR_STOP=1'

set +x
print_bold "Running custom post-processing SQL scripts in /etc/gtfs/sql.d."
set -x

for file in /etc/gtfs/sql.d/*; do
	psql -b -v 'ON_ERROR_STOP=1' -f "$file"
done

set +x
print_bold 'Done!'

cat <<EOF
Run PostgREST with the following environment variables:'
PGUSER=postgrest
PGRST_DB_SCHEMAS=api
PGRST_DB_ANON_ROLE=web_anon
EOF
