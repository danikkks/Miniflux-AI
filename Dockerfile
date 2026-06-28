FROM node:lts-alpine
WORKDIR /app
COPY . .
RUN npm install && npm run lint && npm run build
CMD ["/bin/sh", "-c", "while true; do node miniflux-ai.js; sleep ${PROCESSING_INTERVAL_SECONDS:-300}; done"]
