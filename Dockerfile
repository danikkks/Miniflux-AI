FROM node:lts-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY . .
RUN npm install && npm run lint && npm run build
CMD ["node", "bootstrap.js"]
