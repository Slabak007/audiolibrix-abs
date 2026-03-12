FROM node:20-alpine3.20 AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY server.js ./
RUN npx esbuild server.js --platform=node --bundle --outfile=dist/server.js

FROM node:20-alpine3.20
WORKDIR /app
COPY --from=build /app/dist/server.js ./
EXPOSE 3012
CMD ["node", "server.js"]
