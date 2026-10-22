# Coding standards

- Prefers established, maintained libraries and standards over custom implementations. Confidence: 0.9
- Never implement custom cryptography or authentication protocols. Confidence: 0.95
- Never store credentials, OAuth tokens, passwords or secrets in source control; provide a `.env.example` with placeholders instead. Confidence: 0.95
- Never silently discard user data; preserve conflicting edits rather than overwriting them (no silent last-write-wins). Confidence: 0.9
- Avoids rewriting large portions of a codebase purely to satisfy a code-style preference. Confidence: 0.85
- Values an explicit source-of-truth / data-ownership decision per entity (e.g. note content in files, structured data in the database). Confidence: 0.8
- Favours atomic writes plus revision/content-hash based optimistic concurrency for data integrity. Confidence: 0.8
