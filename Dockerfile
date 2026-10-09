FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json server.mjs probe.mjs probe-manifest.json connection-test.html ./
USER node
ENV NODE_ENV=production PORT=8080 PROBE_ONLY=true
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 CMD ["node", "--input-type=module", "-e", "import http from 'node:http';const r=http.get('http://127.0.0.1:8080/__proxy/health',s=>{s.resume();process.exit(s.statusCode===200?0:1)});r.setTimeout(4000,()=>{r.destroy();process.exit(1)});r.on('error',()=>process.exit(1));"]
CMD ["node", "server.mjs"]
