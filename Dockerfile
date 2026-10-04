FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
COPY --chown=node:node package.json index.html online.html asset-manifest.json project-manifest.json ./
COPY --chown=node:node assets ./assets
COPY --chown=node:node css ./css
COPY --chown=node:node data ./data
COPY --chown=node:node js ./js
COPY --chown=node:node server ./server
COPY --chown=node:node scripts/backup.cjs ./scripts/backup.cjs
RUN mkdir /data && chown node:node /data
USER 1000:1000
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "server/server.cjs"]
