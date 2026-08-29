# Runtime image for an always-on relay.
#
# Node 22 for the global WebSocket the PumpPortal rung uses. Production deps
# only, non-root, and the ledger lives on a mounted volume rather than in the
# image: it is what enforces the daily spend cap across restarts, so losing it
# silently resets the caps.

FROM node:22-alpine

RUN addgroup -S relay && adduser -S relay -G relay

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY bin ./bin
COPY config ./config
COPY index.d.ts ./

# Ledger directory, mounted as a volume in production so records survive a
# container replacement.
RUN mkdir -p /data && chown -R relay:relay /data /app
VOLUME ["/data"]

USER relay

ENV NODE_ENV=production
ENV LAUNCH_RELAY_LEDGER=/data

# Dry run by default. Going live is an explicit act at run time, never a
# property baked into an image someone might deploy by accident.
ENTRYPOINT ["node", "bin/launch-relay.js"]
CMD ["run", "--config", "/app/config/launch-relay.config.json"]
