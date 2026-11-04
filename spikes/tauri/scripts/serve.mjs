// Static server for the built web UI that proxies /api and /health to the throwaway API.
// Usage: node serve.mjs <distDir> <port> <apiPort>
import { createServer, request } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const [dist, port, apiPort] = process.argv.slice(2);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };

createServer(async (req, res) => {
  if (req.url.startsWith("/api") || req.url.startsWith("/health")) {
    const up = request({ host: "127.0.0.1", port: Number(apiPort), path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
    return;
  }
  const clean = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = path.join(dist, clean);
  if (!file.startsWith(dist)) { res.writeHead(403); res.end(); return; }
  let body;
  try { body = await readFile(file); } catch { file = path.join(dist, "index.html"); body = await readFile(file); }
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  res.end(body);
}).listen(Number(port), "127.0.0.1");
