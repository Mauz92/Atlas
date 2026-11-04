//! SQLite store used for check S2. `rusqlite` with the bundled SQLite, WAL, explicit transactions.
use rusqlite::{params, Connection, TransactionBehavior};
use std::{path::Path, time::Duration};

/// Forward-only migrations, tracked in `PRAGMA user_version`.
const MIGRATIONS: &[&str] = &[
    "CREATE TABLE items(id INTEGER PRIMARY KEY, batch INTEGER NOT NULL, title TEXT NOT NULL);
     CREATE INDEX items_title ON items(title);
     CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    "ALTER TABLE items ADD COLUMN updated INTEGER NOT NULL DEFAULT 0;",
];

pub const PAGE_ROWS: i64 = 50;

pub fn open(path: &Path, migrate_to: usize) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", std::env::var("SPIKE_SYNC").unwrap_or_else(|_| "FULL".into()))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    migrate(&conn, migrate_to)?;
    Ok(conn)
}

pub fn migrate(conn: &Connection, to: usize) -> rusqlite::Result<()> {
    let current: usize = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().take(to).skip(current) {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

pub fn latest() -> usize {
    MIGRATIONS.len()
}

pub fn cursor(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key='cursor'),0)", [], |r| r.get(0))
}

/// "Apply page + store cursor" in ONE transaction (the sync pull step).
pub fn apply_page(conn: &mut Connection, batch: i64, rows: i64) -> rusqlite::Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    {
        let mut st = tx.prepare_cached("INSERT INTO items(batch,title,updated) VALUES(?1,?2,?3)")?;
        for i in 0..rows {
            st.execute(params![batch, format!("item-{batch}-{i}"), batch])?;
        }
    }
    tx.execute(
        "INSERT INTO meta(key,value) VALUES('cursor',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![batch.to_string()],
    )?;
    tx.commit()
}

/// Invariant: items of every batch <= cursor are all there, none beyond it, integrity ok.
pub fn verify(conn: &Connection) -> Result<i64, String> {
    let c = cursor(conn).map_err(|e| e.to_string())?;
    let n_ok: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE batch<=?1", [c], |r| r.get(0)).map_err(|e| e.to_string())?;
    let beyond: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE batch>?1", [c], |r| r.get(0)).map_err(|e| e.to_string())?;
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if n_ok != c * PAGE_ROWS || beyond != 0 || integrity != "ok" {
        return Err(format!("INCONSISTENT cursor={c} rows_le_cursor={n_ok} rows_beyond={beyond} integrity={integrity}"));
    }
    Ok(c)
}

pub fn kv_read(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    match conn.query_row("SELECT value FROM kv WHERE key=?1", [key], |r| r.get(0)) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn kv_write(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value])?;
    Ok(())
}

pub fn kv_remove(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM kv WHERE key=?1", [key])?;
    Ok(())
}
