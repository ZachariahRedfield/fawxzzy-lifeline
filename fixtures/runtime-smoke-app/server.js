import http from "node:http";
import { existsSync } from "node:fs";

const port = Number(process.env.PORT || 4387);

const server = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    if (process.env.HEALTH_FAIL_FLAG_FILE && existsSync(process.env.HEALTH_FAIL_FLAG_FILE)) {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("unhealthy");
      return;
    }

    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }

  if (request.url === "/crash") {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("crashing");
    setTimeout(() => process.exit(1), 25);
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, path: request.url || "/" }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`runtime-smoke-app listening on ${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
