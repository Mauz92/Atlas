// Assemble the shell's frontend (`apps/desktop/dist`): the built web UI (`apps/web/dist`), the sign-in page, and the
// bridge script, which is added to every page. Run `npm run build` in apps/web first (done by build-linux.sh).
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const webDist = path.resolve(root, "../web/dist");
const out = path.join(root, "dist");
if (!existsSync(path.join(webDist, "index.html"))) throw new Error("apps/web/dist is missing: run `npm run build` in apps/web first");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(webDist, out, { recursive: true });
rmSync(path.join(out, "sw.js"), { force: true }); // no service worker in the shell (SYNC-09c)

const common = { bundle: true, format: "iife", target: ["safari15", "chrome110"], minify: true, logLevel: "warning", legalComments: "none" };
await build({ ...common, entryPoints: [path.join(root, "src/bootstrap.ts")], outfile: path.join(out, "atlas-desktop.js") });
await build({ ...common, entryPoints: [path.join(root, "src/welcome.ts")], outfile: path.join(out, "welcome.js") });
cpSync(path.join(root, "src/welcome.html"), path.join(out, "welcome.html"));
cpSync(path.join(root, "src/welcome.css"), path.join(out, "welcome.css"));

// the bridge must exist before the web app's own scripts run
const indexPath = path.join(out, "index.html");
const index = readFileSync(indexPath, "utf8");
if (!index.includes("<head>")) throw new Error("unexpected index.html: no <head>");
writeFileSync(indexPath, index.replace("<head>", '<head>\n    <script src="/atlas-desktop.js"></script>'));
console.log("staged", out);
