FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json server.mjs probe.mjs probe-manifest.json connection-test.html boot.mjs quest-v25.enc quest-v25.manifest.json ./
RUN mkdir -p /app/data /app/runtime && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=8080 PALMI_BIND_PORT=8080 PROBE_ONLY=true NODE_OPTIONS="--max-old-space-size=192"
EXPOSE 8080
# Timeweb checks the configured /__proxy/health path directly. Do not override
# its platform health probe with an additional Node process in this container.
CMD ["node", "boot.mjs"]
