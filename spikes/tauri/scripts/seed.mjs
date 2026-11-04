// Seed the throwaway stack with data that exercises the UI (notes incl. a 5 000-line one, tasks, projects).
// Usage: node scripts/seed.mjs   (reads $SPIKE_OUT/stack.json). Uses a device bearer token: no cookies/CSRF.
import { readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const out = process.env.SPIKE_OUT ?? path.join(tmpdir(), "atlas-spike-out");
const s = JSON.parse(readFileSync(path.join(out, "stack.json"), "utf8"));
const base = `http://127.0.0.1:${s.apiPort}`;
const j = async (method, p, body, token) => {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const { token } = await j("POST", "/api/devices", { email: s.owner.email, password: s.owner.password, name: "seed", platform: "linux" });
const projects = [];
for (const name of ["Launch plan", "Home renovation", "Reading list"]) projects.push(await j("POST", "/api/projects", { name, description: `Throwaway project ${name}` }, token));
const statuses = ["inbox", "next", "in_progress", "completed"];
for (let i = 0; i < 24; i++) {
  await j("POST", "/api/tasks", { title: `Task ${i + 1}: ${["Write spec", "Review PR", "Book travel", "Call plumber", "Plan sprint", "Read paper"][i % 6]}`, status: statuses[i % 4],
    priority: ["none", "low", "medium", "high"][i % 4], project_id: i % 3 === 0 ? null : projects[i % 3].id, due_at: new Date(Date.now() + (i - 5) * 86400000).toISOString(), tags: i % 5 === 0 ? ["urgent"] : [] }, token);
}
const rich = `# Rich note

Some **bold**, _italic_, \`code\`, a [link](https://example.com) and a wiki link [[spike/Big note]].

## Checklist
- [ ] first task
- [x] done task
- [ ] third

## Table
| a | b | c |
|---|---|---|
| 1 | 2 | 3 |

## Code
\`\`\`ts
const x: number = 1;
\`\`\`

> quote with ünïcödé, 日本語, emoji 🙂
`;
await j("POST", "/api/notes", { path: "spike/Rich note.md", content: rich }, token);
let big = "# Big note\n\n";
for (let i = 1; i <= 5000; i++) big += i % 50 === 0 ? `\n## Section ${i / 50}\n` : `Line ${i}: the quick brown fox jumps over the lazy dog, **bold ${i}** and [[spike/Rich note]].\n`;
const bigNote = await j("POST", "/api/notes", { path: "spike/Big note.md", content: big }, token);
const richNote = (await j("GET", "/api/notes", null, token));
console.log(JSON.stringify({ seeded: true, bigNoteId: bigNote.id, notes: (richNote.items ?? richNote).length ?? "?" }));
