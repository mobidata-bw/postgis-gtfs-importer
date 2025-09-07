# syntax=docker/dockerfile:1.9
# ^ needed for ADD --checksum=…

FROM golang:1-alpine AS gtfsclean

WORKDIR /app

# Commit for snapshot 5 of public-transport/gtfsclean
# https://github.com/public-transport/gtfsclean/releases/tag/snapshot-5
ARG GTFSCLEAN_GIT_REF=bb3ea74f66ef9bc07dc1bd038c3f653e10f0ade0

RUN apk add --no-cache git file

RUN git clone --depth 1 --revision=${GTFSCLEAN_GIT_REF} https://github.com/public-transport/gtfsclean.git .

RUN env GOOS=linux GOARCH=arm64 GOARM=v8 go build \
	&& ls -lh gtfsclean \
	&& file gtfsclean

FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="postgis-gtfs-importer"
LABEL org.opencontainers.image.description="Imports GTFS data into a PostGIS database, using gtfstidy & gtfs-via-postgres."
LABEL org.opencontainers.image.authors="MobiData-BW IPL contributors <mobidata-bw@nvbw.de>"
LABEL org.opencontainers.image.documentation="https://github.com/mobidata-bw/postgis-gtfs-importer"

WORKDIR /importer

# todo: what for?
ENV TERM=xterm-256color

# curl is needed to download the GTFS
# moreutils is needed for sponge
# postgresql-client is needed for psql
# note: curl-mirror.mjs would need gunzip *if* the HTTP response was gzipped
RUN apt update && apt install -y \
	bash \
	curl \
	moreutils \
	postgresql-client \
	unzip \
	zstd \
	&& rm -rf /var/lib/apt/lists/*

# > Alas, there is no way to tell Node.js to interpret a file with an arbitrary extension as an ESM module. That’s why we have to use the extension .mjs. Workarounds are possible but complicated, as we’ll see later.
# https://exploringjs.com/nodejs-shell-scripting/ch_creating-shell-scripts.html#node.js-esm-modules-as-standalone-shell-scripts-on-unix
# > A script such as homedir.mjs does not need to be executable on Unix because npm installs it via an executable symbolic link […].
# https://exploringjs.com/nodejs-shell-scripting/ch_creating-shell-scripts.html#how-npm-installs-shell-scripts
ADD \
	--checksum=sha256:59bb1efdeef33ea380f1035fae0c3810a3063de2f400d0542695ab1bc8b9f95d \
	https://gist.github.com/derhuerst/745cf09fe5f3ea2569948dd215bbfe1a/raw/cefaf64e2dd5bfde30de12017c4823cdc89ac64c/mirror.mjs \
	/opt/curl-mirror.mjs
RUN \
	ln -s /opt/curl-mirror.mjs /usr/local/bin/curl-mirror && \
	chmod +x /usr/local/bin/curl-mirror

COPY --from=gtfsclean /app/gtfsclean /usr/local/bin/gtfsclean

# todo: gtfs-via-postgres is Prosperity-dual-licensed, obtain a purely Apache-licensed version
ADD package.json ./
RUN npm install --omit dev && npm cache clean --force

ADD . .

# When evaluating SQL scripts in postprocessing.d, import.sh passes $SHELL into psql explicitly, which in turn executes backtick-ed code blocks using $SHELL.
# Because the script inlined within those backticks/backquotes might rely on certain behavior, to achieve stability, we define this explicitly here, rather than relying on the implicit default from our base image.
ENV SHELL=/bin/bash

ENTRYPOINT []
CMD ["/usr/local/bin/node", "importer.js"]
