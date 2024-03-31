#!/usr/bin/env bash

print_bold () {
	if [ -t 0 ]; then
		echo "$(tput bold)$1$(tput sgr0)"
	else
		echo "$1"
	fi
}

gtfs_tmp_dir="${GTFS_TMP_DIR:-/tmp/gtfs}"

zip_path="$gtfs_tmp_dir/gtfs.zip"
extracted_path="$gtfs_tmp_dir/gtfs"
tidied_path="$gtfs_tmp_dir/tidied.gtfs"
