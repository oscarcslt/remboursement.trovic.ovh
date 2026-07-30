FROM node:22-alpine

WORKDIR /app

COPY server/package.json ./server/package.json
RUN npm install --omit=dev --prefix server

COPY server/src ./server/src
COPY public ./public

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/src/server.js"]
