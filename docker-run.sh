#!/bin/bash

docker run --rm --init --env-file ./.env -v "$PWD/data:/data" -e DATABASE_PATH=/data/miniflux-ai.db miniflux-ai
