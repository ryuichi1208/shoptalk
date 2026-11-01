FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/load.js ./scripts/load.js
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
