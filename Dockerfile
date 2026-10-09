FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json server.mjs probe.mjs probe-manifest.json ./
USER node
ENV NODE_ENV=production PORT=8080 PROBE_ONLY=true
EXPOSE 8080
CMD ["node", "server.mjs"]
