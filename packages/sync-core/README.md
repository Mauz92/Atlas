# @atlas/sync-core — client core of the local-first sync protocol (SYNC-08)

Framework-free TypeScript: **no** React, DOM, `window`, global `fetch`, `localStorage`, wall clock, timers or random source
(enforced by `src/framework-free.test.ts`, an ESLint `no-restricted-globals` rule and the `node` vitest environment). A host injects
ports (`src/ports.ts`): `Transport`, `LocalStore`, `Clock` (monotonic for backoff and deadlines, wall clock for display only, D11),
`Random`, `IdGenerator`, `Logger` (primitive fields only: no content), optional `Credentials` and `Sha256`.

Contract: `docs/SYNC_PROTOCOL.md`. Decisions: ADR-0066. Evidence: `docs/ACCEPTANCE.md` SYNC-08. No runtime dependencies.

```ts
const engine = new SyncEngine({ store, transport, clock, ids, random, credentials, logger });
await engine.createEntity("task", { title: "Pay rent" });   // durable, addressable at once (client id)
await engine.editNote(id, text);                              // pinned working copy; edits in flight are rebased
await engine.tick();                                          // starts at most one request; call it on a timer / event
engine.subscribe((s) => render(s));                           // pending/failed/conflicts, state, halt, lastSyncAt, online
```

| Module | Responsibility |
|---|---|
| `engine.ts` | tick-driven state machine: FIFO push (one request in flight), pull, snapshot/restore, halts, user actions |
| `entities.ts` | apply rules: by revision, gap-fill-only acknowledgements, tombstones, edit-wins revive |
| `merge3.ts`, `portable.ts` | note text rebase (client twin of the server merge), portable-path check |
| `backoff.ts` | exponential backoff, full jitter, `Retry-After` |
| `view.ts` | what the user sees: server state with pending operations laid over it |
| restore choices | `confirmRestore()` re-creates what a restored server lost; `discardLocalAndRedownload()` (SYNC-11) drops unsent operations, drafts and problems and adopts the server (never automatic: the host asks the person) |
| `reminders.ts` | device reminders (M8-04b-ii, opt-in `reminders: true`): `reminderViews()` (reminders joined with their task, `open`/`dirty` from the local queue), `submitReminderAction()` (queued, idempotent snooze/dismiss with `acted_at`), `SyncReminderSource`/`SyncActionSink` for `@atlas/reminder-core`; `types_synced` backfill is in `engine.ts` |
| `testing/` | `MemoryStore` (real transactions, injectable crash), `ScriptedTransport`, fakes |
| `adapters/` | `KeyValueLocalStore` (over the web app's key-value store), `createFetchTransport` (injected `fetch`, HTTPS only), `legacyQueueSnapshot` (M7 status shape) |
| `sim/` | the simulation: TS model server, fault network, invariants, planted bugs, real-API conformance |

## Running

| Command (from `apps/web`, whose vitest/eslint/tsc the package uses) | Effect |
|---|---|
| `npm run test` (part of `./scripts/verify.sh`) | unit tests + default simulation (12 seeds x 120 steps per scenario) |
| `ATLAS_SYNC_SEEDS=150 ATLAS_SYNC_STEPS=250 npx vitest run --project sync-core model.sim` | model soak |
| `ATLAS_SYNC_SEED=<n> npx vitest run --project sync-core model.sim` | one seed (every failure prints it) |
| `ATLAS_SYNC_SEEDS=1000 ATLAS_SYNC_STEPS=300 npx vitest run --project sync-core reminders.sim --testTimeout 100000000` | reminder soak (M8-04b-ii: sync-core + reminder-core schedulers on the model server; `ATLAS_SYNC_SEED=<n>` repeats one seed) |
| `npx vitest run --project sync-core planted` | the planted-defect checks (34 for the sync model, 18 for the reminder simulation) |
| `ATLAS_SYNC_REAL=1 ATLAS_SYNC_REAL_SEEDS=8 ATLAS_SYNC_STEPS=150 npx vitest run --project sync-core-real` | real API (needs `services/api/.venv`, PostgreSQL on 127.0.0.1:5432, container `atlas-db-1`); throwaway DB `atlas_e2e_<random>` only |

`npm run lint` in `apps/web` also lints this package; `npm run typecheck` type-checks it.
