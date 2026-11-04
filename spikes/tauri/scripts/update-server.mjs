// Local static server for the updater test (never publishes anything). Usage: node update-server.mjs <dir> [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
const [dir, port = "18777"] = process.argv.slice(2);
createServer(async (req, res) => {
  const f = path.join(path.resolve(dir), decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!f.startsWith(path.resolve(dir))) { res.writeHead(403); res.end(); return; }
  try { const b = await readFile(f); res.writeHead(200, { "content-type": f.endsWith(".json") ? "application/json" : "application/octet-stream", "content-length": b.length }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
}).listen(Number(port), "127.0.0.1");
