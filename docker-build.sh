#!/bin/bash

docker rm -f miniflux-ai 2>/dev/null
docker rmi -f miniflux-ai 2>/dev/null
docker volume prune -f
docker build -t miniflux-ai .
