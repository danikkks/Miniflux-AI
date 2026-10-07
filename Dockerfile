FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY . .
RUN npm install && npm run lint && npm run build
EXPOSE 3000
CMD ["node", "bootstrap.js"]
