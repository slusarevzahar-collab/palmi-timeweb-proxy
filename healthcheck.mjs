import http from 'node:http';

// No database writes, credentials or external services. Fail closed on timeout.
const port = Number(process.env.PALMI_BIND_PORT || process.env.PORT || 8080);
const deadline = setTimeout(() => process.exit(1), 5000);
const request = http.get({hostname:'127.0.0.1', port, path:'/__proxy/health'}, response => {
  response.resume();
  clearTimeout(deadline);
  process.exit(response.statusCode >= 200 && response.statusCode < 300 ? 0 : 1);
});
request.setTimeout(4000, () => request.destroy(new Error('Health timeout')));
request.on('error', () => { clearTimeout(deadline); process.exit(1); });
