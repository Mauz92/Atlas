# services/worker — background processing

Intended: durable background jobs — calendar synchronisation, retries and reminder
scheduling — sharing the `api` codebase and PostgreSQL, run as a separate process.

Job/queue design: `docs/ARCHITECTURE.md` §6, `docs/DECISIONS.md` ADR-0005.
Not yet implemented. First work is Milestone 1 (M1-08).
