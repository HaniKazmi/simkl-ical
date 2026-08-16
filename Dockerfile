FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production

# --chown on the COPY rather than a chown -R afterwards, which duplicated the
# whole node_modules tree into a second layer.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
# package.json is needed at runtime: "type": "module" governs how Node loads
# src/, and config.ts reads the version out of it for the SIMKL User-Agent.
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# The token and cache live on a mounted volume, written as the unprivileged user.
RUN mkdir -p /data && chown node:node /data
USER node

ENV DATA_DIR=/data
ENV PORT=3000
EXPOSE 3000

# Reads PORT rather than assuming 3000. Hardcoding it meant setting PORT left
# the container permanently unhealthy while it was in fact serving fine.
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.ts"]
