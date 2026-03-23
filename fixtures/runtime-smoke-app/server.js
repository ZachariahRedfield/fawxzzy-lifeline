import http from 'node:http';

const port = Number(process.env.PORT || 4310);

const server = http.createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }

  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true, path: request.url || '/' }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`runtime-smoke-app listening on ${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
