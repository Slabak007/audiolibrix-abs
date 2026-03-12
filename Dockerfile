FROM node:20-alpine3.20 AS build
WORKDIR /app
COPY package.json server.js ./
RUN npm install

FROM node:20-alpine3.20
WORKDIR /app
COPY --from=build /app/server.js ./  # pokud nemáš dist
EXPOSE 3001
CMD ["node", "server.js"]
