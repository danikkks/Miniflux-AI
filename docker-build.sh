#!/bin/bash

docker rm -fv miniflux-ai 2>/dev/null
docker rmi -f miniflux-ai 2>/dev/null
docker build -t miniflux-ai .
