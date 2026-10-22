#!/bin/bash

set -a; source ./.env; set +a
port="${WEB_PORT:-3000}"

docker run --rm --init --env-file ./.env -p "$port:$port" -v "$PWD/data:/data" -e DATABASE_PATH=/data/miniflux-ai.db -e LOG_DIR=/data/logs miniflux-ai
