# syntax=docker/dockerfile:1.9
# ^ needed for ADD --checksum=…

FROM golang:1-alpine AS gtfsclean

WORKDIR /app

# https://docs.docker.com/engine/reference/builder/#automatic-platform-args-in-the-global-scope
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT

RUN apk add --no-cache git file

# https://github.com/public-transport/gtfsclean
# kept up-to-date by Renovate Bot
ARG GTFSCLEAN_GIT_REF=8a1a1ee8d37e57afb238302691574b6bae3f681b
RUN git clone -q --depth 1 --revision=${GTFSCLEAN_GIT_REF} https://github.com/public-transport/gtfsclean.git .

# golang:1-alpine sets $GOPATH to /go
RUN --mount=type=cache,id=go-build,target=/go \
	set -eux -o pipefail; \
	[[ "$TARGETARCH" = 'arm64' && -n "$TARGETVARIANT" ]] && export GOARM="$TARGETVARIANT"; \
	env GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build \
	&& ls -lh gtfsclean \
	&& file gtfsclean \
	&& ./gtfsclean --help 2>/dev/null

FROM node:24-alpine3.23

LABEL org.opencontainers.image.title="postgis-gtfs-importer"
LABEL org.opencontainers.image.description="Imports GTFS data into a PostGIS database, using gtfstidy & gtfs-via-postgres."
LABEL org.opencontainers.image.authors="MobiData-BW IPL contributors <mobidata-bw@nvbw.de>"
LABEL org.opencontainers.image.documentation="https://github.com/mobidata-bw/postgis-gtfs-importer"

WORKDIR /importer

# todo: what for?
ENV TERM=xterm-256color

# curl is needed to download the GTFS
# moreutils is needed for sponge
# ncurses is needed for tput
# postgresql-client is needed for psql
# note: curl-mirror.mjs would need gunzip *if* the HTTP response was gzipped
RUN apk update && apk add --no-cache \
	bash \
	curl \
	moreutils \
	ncurses \
	postgresql-client \
	unzip \
	zstd

# > Alas, there is no way to tell Node.js to interpret a file with an arbitrary extension as an ESM module. That’s why we have to use the extension .mjs. Workarounds are possible but complicated, as we’ll see later.
# https://exploringjs.com/nodejs-shell-scripting/ch_creating-shell-scripts.html#node.js-esm-modules-as-standalone-shell-scripts-on-unix
# > A script such as homedir.mjs does not need to be executable on Unix because npm installs it via an executable symbolic link […].
# https://exploringjs.com/nodejs-shell-scripting/ch_creating-shell-scripts.html#how-npm-installs-shell-scripts
ADD \
	--checksum=sha256:3d1a5454e0684149bc426d79345f6677b39da293209be372d0b87c04a7c409f0 \
	https://gist.githubusercontent.com/derhuerst/745cf09fe5f3ea2569948dd215bbfe1a/raw/27aa4919b5676abda8f9e0d90c3ec43d0d63f3d7/mirror.mjs \
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
