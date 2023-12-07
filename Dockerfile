# syntax=docker/dockerfile:1.6
# ^ needed for ADD --checksum=…

FROM node:20-bookworm-slim
LABEL org.opencontainers.image.title="GTFS importer, using gtfstidy & gtfs-via-postgres to import GTFS data into a PostGIS database."
LABEL org.opencontainers.image.authors="MobiData-BW IPL contributors <mobidata-bw@nvbw.de>"

WORKDIR /importer

ENV TERM=xterm-256color

# https://docs.docker.com/engine/reference/builder/#automatic-platform-args-in-the-global-scope
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT

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

# > Alas, there is no way to tell node to interpret a file with an arbitrary extension as an ESM module. That’s why we have to use the extension .mjs. Workarounds are possible but complicated, as we’ll see later.
# https://exploringjs.com/nodejs-shell-scripting/ch_creating-shell-scripts.html#node.js-esm-modules-as-standalone-shell-scripts-on-unix
# > A script such as homedir.mjs does not need to be executable on Unix because npm installs it via an executable symbolic link […].
# https://exploringjs.com/nodejs-shell-scripting/ch_creating-shell-scripts.html#how-npm-installs-shell-scripts
ADD \
	--checksum=sha256:95b995d6e30cb765a02c14f265526801664ea9e03a090951cab0aee7fed103ee \
	https://gist.github.com/derhuerst/745cf09fe5f3ea2569948dd215bbfe1a/raw/6df4a02302d77edac674fec52ed1c0b32a795a37/mirror.mjs \
	/opt/curl-mirror.mjs
RUN \
	ln -s /opt/curl-mirror.mjs /usr/local/bin/curl-mirror && \
	chmod +x /usr/local/bin/curl-mirror

RUN \
	curl -fsSL \
	-H 'User-Agent: gtfs-importer (github.com/mobidata-bw/ipl-orchestration)' \
	-o /usr/local/bin/gtfstidy \
	"https://github.com/patrickbr/gtfstidy/releases/download/v0.2/gtfstidy.v0.2.$TARGETOS.$TARGETARCH" \
	&& chmod +x /usr/local/bin/gtfstidy

# todo: gtfs-via-postgres is Prosperity-dual-licensed, obtain a purely Apache-licensed version
# todo: Docker layer caching won't pull the latest 4.x release
RUN npm install -g gtfs-via-postgres@'^4.8.2'

ADD package.json ./
RUN npm install --omit dev && npm cache clean --force

ADD . .

ENTRYPOINT []
CMD ["/usr/local/bin/node", "importer.js"]
