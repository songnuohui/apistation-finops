FROM node:22-alpine

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8090
USER node
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8090/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
