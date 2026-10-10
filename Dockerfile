FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json server.mjs probe.mjs probe-manifest.json connection-test.html boot.mjs quest-v25.enc quest-v25.manifest.json ./
RUN mkdir -p /app/data /app/runtime && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=8080 PALMI_BIND_PORT=8080 PROBE_ONLY=true NODE_OPTIONS="--max-old-space-size=192"
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=20s --start-period=30s --retries=3 CMD ["node", "--input-type=module", "-e", "import http from 'node:http';const r=http.get('http://127.0.0.1:8080/__proxy/health',s=>{s.resume();process.exit(s.statusCode===200?0:1)});r.setTimeout(15000,()=>{r.destroy();process.exit(1)});r.on('error',()=>process.exit(1));"]
CMD ["node", "boot.mjs"]
