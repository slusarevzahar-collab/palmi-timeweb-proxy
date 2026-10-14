FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json server.mjs probe.mjs probe-manifest.json connection-test.html boot.mjs healthcheck.mjs quest-v25.enc quest-v25.manifest.json ./
RUN mkdir -p /app/data /app/runtime && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=8080 PALMI_BIND_PORT=8080 PROBE_ONLY=true NODE_OPTIONS="--max-old-space-size=192"
EXPOSE 8080
# Keep the Timeweb panel health path empty so Docker's explicit, bounded
# HTTP probe is used. The application remains closed until owner restore.
HEALTHCHECK --interval=20s --timeout=8s --start-period=30s --retries=3 CMD ["node", "--max-old-space-size=16", "healthcheck.mjs"]
CMD ["node", "boot.mjs"]
