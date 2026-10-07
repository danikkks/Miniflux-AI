#!/bin/bash

docker run --rm --init --env-file ./.env -p 3000:3000 -v "$PWD/data:/data" -e DATABASE_PATH=/data/miniflux-ai.db miniflux-ai
