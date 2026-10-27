# syntax=docker/dockerfile:1
# Build context is the repository root: docker build -f server/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json server/.npmrc ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/build_ca npm ci --no-audit --no-fund; \
    else npm ci --no-audit --no-fund; fi
COPY shared /app/shared
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production APP_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /app/server
COPY --from=build --chown=node:node /app/server/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./dist
COPY --chown=node:node server/package.json ./
COPY --chown=node:node server/config ./config
COPY --chown=node:node server/supabase ./supabase
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server/src/production/index.js"]
