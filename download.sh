#!/usr/bin/env bash
set -e
set -u
set -E # abort if subshells fail
set -o pipefail

source "$(dirname "$(realpath "$0")")/lib.sh"

ua="${GTFS_DOWNLOAD_USER_AGENT:?'missing/empty $GTFS_DOWNLOAD_USER_AGENT'}"
gtfs_url="${GTFS_DOWNLOAD_URL:?'missing/empty $GTFS_DOWNLOAD_URL'}"

verbose="${GTFS_DOWNLOAD_VERBOSE:-true}"
if [ "$verbose" != false ]; then
	set -x # enable xtrace
fi

print_bold "Downloading the GTFS feed from $GTFS_DOWNLOAD_URL."

mkdir -p "$gtfs_tmp_dir"

# custom curl-based HTTP mirroring/download script
# > curl-mirror [--tmp-prefix …] [--log-level …] [--debug-curl] <url> <dest-path> [-- curl-opts...]
# see https://gist.github.com/derhuerst/745cf09fe5f3ea2569948dd215bbfe1a
	# --times \
curl-mirror \
	--tmp-prefix "$zip_path.mirror-" \
	"$gtfs_url" "$zip_path" \
	-- \
	-H "User-Agent: $ua"
