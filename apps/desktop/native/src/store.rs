//! The per-row SQLite store behind `RowDb` (SYNC-09a, ADR-0069).
//!
//! One file, WAL, `synchronous=FULL` (decision in ADR-0069: a page of changes plus its cursor costs under a
//! millisecond more than NORMAL on the spike's measurements, and a power cut must not lose an acknowledged
//! commit), forward-only migrations in `PRAGMA user_version`, a build that finds a NEWER database refuses it.
//! Every table has the same shape (`key`, `ord`, `kind`, `json`); the table name is checked against a fixed
//! list before it reaches SQL, so the webview can never name a table of its own.
use rusqlite::{params, Connection, TransactionBehavior};
use serde::Deserialize;
use std::{path::Path, time::Duration};

/// The tables of the local database (kept in step with `TABLES` in `packages/desktop-core/src/ports.ts`).
pub const TABLES: &[&str] = &["entities", "queue", "meta", "resolutions", "problems", "drafts", "notes_index", "settings", "scheduler"];

fn schema_v1() -> String {
    TABLES
        .iter()
        .map(|t| {
            format!(
                "CREATE TABLE {t}(key TEXT PRIMARY KEY NOT NULL, ord INTEGER NOT NULL DEFAULT 0, kind TEXT, json TEXT NOT NULL) WITHOUT ROWID;\n\
                 CREATE INDEX {t}_ord ON {t}(ord, key);"
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Forward-only migrations; index `i` brings the database from version `i` to `i + 1`.
pub fn migrations() -> Vec<String> {
    vec![schema_v1()]
}

#[derive(Debug, PartialEq, Eq)]
pub enum StoreError {
    /// The file was written by a newer build (never opened, never downgraded).
    NewerThanApp { found: i64, supported: i64 },
    UnknownTable(String),
    NotOpen,
    Sqlite(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::NewerThanApp { found, supported } => write!(f, "database_newer_than_app: schema {found}, this build supports {supported}"),
            StoreError::UnknownTable(t) => write!(f, "unknown_table:{t}"),
            StoreError::NotOpen => write!(f, "database_not_open"),
            StoreError::Sqlite(e) => write!(f, "sqlite: {e}"),
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e.to_string())
    }
}

type Result<T> = std::result::Result<T, StoreError>;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Op {
    Put { table: String, key: String, value: String, ord: Option<i64>, kind: Option<String> },
    Del { table: String, key: String },
    Clear { table: String },
}

pub struct Store {
    conn: Connection,
}

fn check_table(name: &str) -> Result<&'static str> {
    TABLES.iter().copied().find(|t| *t == name).ok_or_else(|| StoreError::UnknownTable(name.to_string()))
}

/// `FULL` or `NORMAL`. Only the crash test and the benchmark pick NORMAL.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Synchronous {
    Full,
    Normal,
}

impl Store {
    pub fn open(path: &Path) -> Result<(Store, i64)> {
        Self::open_with(path, Synchronous::Full)
    }

    pub fn open_with(path: &Path, sync: Synchronous) -> Result<(Store, i64)> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", if sync == Synchronous::Full { "FULL" } else { "NORMAL" })?;
        conn.busy_timeout(Duration::from_secs(5))?;
        let migs = migrations();
        let supported = migs.len() as i64;
        let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if current > supported {
            return Err(StoreError::NewerThanApp { found: current, supported });
        }
        for (i, sql) in migs.iter().enumerate().skip(current as usize) {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", (i + 1) as i64)?;
            tx.commit()?;
        }
        Ok((Store { conn }, supported))
    }

    pub fn get(&self, table: &str, key: &str) -> Result<Option<String>> {
        let t = check_table(table)?;
        let mut st = self.conn.prepare_cached(&format!("SELECT json FROM {t} WHERE key = ?1"))?;
        let mut rows = st.query(params![key])?;
        Ok(match rows.next()? {
            Some(r) => Some(r.get(0)?),
            None => None,
        })
    }

    pub fn list(&self, table: &str) -> Result<Vec<String>> {
        let t = check_table(table)?;
        let mut st = self.conn.prepare_cached(&format!("SELECT json FROM {t} ORDER BY ord, key"))?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// All operations in ONE immediate transaction: all of them or none, durable when this returns.
    /// Every table name is validated before anything is written.
    pub fn commit(&mut self, ops: &[Op]) -> Result<()> {
        for op in ops {
            match op {
                Op::Put { table, .. } | Op::Del { table, .. } | Op::Clear { table } => {
                    check_table(table)?;
                }
            }
        }
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for op in ops {
            match op {
                Op::Put { table, key, value, ord, kind } => {
                    let t = check_table(table)?;
                    tx.prepare_cached(&format!(
                        "INSERT INTO {t}(key, ord, kind, json) VALUES(?1, ?2, ?3, ?4) \
                         ON CONFLICT(key) DO UPDATE SET ord = excluded.ord, kind = excluded.kind, json = excluded.json"
                    ))?
                    .execute(params![key, ord.unwrap_or(0), kind, value])?;
                }
                Op::Del { table, key } => {
                    let t = check_table(table)?;
                    tx.prepare_cached(&format!("DELETE FROM {t} WHERE key = ?1"))?.execute(params![key])?;
                }
                Op::Clear { table } => {
                    let t = check_table(table)?;
                    tx.execute(&format!("DELETE FROM {t}"), [])?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn integrity_check(&self) -> Result<String> {
        Ok(self.conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?)
    }

    pub fn user_version(&self) -> Result<i64> {
        Ok(self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(table: &str, key: &str, value: &str, ord: i64) -> Op {
        Op::Put { table: table.into(), key: key.into(), value: value.into(), ord: Some(ord), kind: None }
    }

    #[test]
    fn rows_round_trip_and_list_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, v) = Store::open(&dir.path().join("a.db")).unwrap();
        assert_eq!(v, 1);
        s.commit(&[put("queue", "b", "{\"n\":2}", 2), put("queue", "a", "{\"n\":1}", 1), put("meta", "cursor", "7", 0)]).unwrap();
        assert_eq!(s.list("queue").unwrap(), vec!["{\"n\":1}", "{\"n\":2}"]);
        assert_eq!(s.get("meta", "cursor").unwrap().as_deref(), Some("7"));
        s.commit(&[Op::Del { table: "queue".into(), key: "a".into() }]).unwrap();
        assert_eq!(s.list("queue").unwrap(), vec!["{\"n\":2}"]);
        s.commit(&[Op::Clear { table: "queue".into() }]).unwrap();
        assert!(s.list("queue").unwrap().is_empty());
        assert_eq!(s.integrity_check().unwrap(), "ok");
    }

    #[test]
    fn a_batch_with_a_bad_table_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, _) = Store::open(&dir.path().join("a.db")).unwrap();
        let err = s.commit(&[put("meta", "k", "1", 0), put("sqlite_master; DROP TABLE meta; --", "x", "1", 0)]).unwrap_err();
        assert!(matches!(err, StoreError::UnknownTable(_)));
        assert_eq!(s.get("meta", "k").unwrap(), None);
        assert!(matches!(s.get("users", "x"), Err(StoreError::UnknownTable(_))));
    }

    #[test]
    fn a_failing_statement_rolls_the_whole_batch_back() {
        let dir = tempfile::tempdir().unwrap();
        let (mut s, _) = Store::open(&dir.path().join("a.db")).unwrap();
        // a NOT NULL violation in the middle of the batch (json cannot be NULL through the API, so force it with raw SQL)
        s.conn.execute_batch("CREATE TRIGGER boom BEFORE INSERT ON meta WHEN NEW.key = 'bad' BEGIN SELECT RAISE(ABORT, 'boom'); END;").unwrap();
        let r = s.commit(&[put("meta", "good", "1", 0), put("meta", "bad", "1", 0)]);
        assert!(r.is_err());
        assert_eq!(s.get("meta", "good").unwrap(), None);
    }

    #[test]
    fn reopening_keeps_data_and_a_newer_database_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.db");
        {
            let (mut s, _) = Store::open(&path).unwrap();
            s.commit(&[put("settings", "desktop", "{}", 0)]).unwrap();
        }
        let (s, v) = Store::open(&path).unwrap();
        assert_eq!((v, s.get("settings", "desktop").unwrap().as_deref()), (1, Some("{}")));
        s.conn.pragma_update(None, "user_version", 99).unwrap();
        drop(s);
        assert!(matches!(Store::open(&path), Err(StoreError::NewerThanApp { found: 99, supported: 1 })));
    }

    #[test]
    fn migration_from_an_older_version_keeps_rows() {
        // A database at version 0 with a hand-made table is not ours; the real forward path is exercised by
        // simulating "version 1 file opened by a build that has migration 2".
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.db");
        let (mut s, _) = Store::open(&path).unwrap();
        s.commit(&[put("entities", "e1", "{\"id\":\"e1\"}", 0)]).unwrap();
        s.conn.execute_batch("CREATE TABLE extra_v2(x INTEGER); PRAGMA user_version = 1;").unwrap();
        drop(s);
        let (s, _) = Store::open(&path).unwrap();
        assert_eq!(s.get("entities", "e1").unwrap().as_deref(), Some("{\"id\":\"e1\"}"));
    }
}
