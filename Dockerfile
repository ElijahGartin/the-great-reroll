FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS runtime
RUN mkdir /data && chown 1000:1000 /data

FROM gcr.io/distroless/cc-debian13:nonroot@sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime /usr/local/LICENSE /usr/share/doc/node/LICENSE
COPY --from=runtime --chown=1000:1000 /data /data
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
COPY --chown=1000:1000 package.json index.html online.html how-to-play.html asset-manifest.json project-manifest.json ./
COPY --chown=1000:1000 assets ./assets
COPY --chown=1000:1000 css ./css
COPY --chown=1000:1000 data ./data
COPY --chown=1000:1000 js ./js
COPY --chown=1000:1000 server ./server
COPY --chown=1000:1000 scripts/backup.cjs ./scripts/backup.cjs
USER 1000:1000
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["/usr/local/bin/node", "server/server.cjs"]
