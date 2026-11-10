//! SYNC-09a: "kill -9 at random points" durability test of the per-row store (the spike did 100 runs;
//! this is the product code and the product `Store::commit`). Invariant after every kill: the file opens,
//! `integrity_check` is ok, every page up to the stored cursor is complete, no row of a later page exists.
use atlas_desktop_native::store::Store;
use std::{process::{Command, Stdio}, thread, time::Duration};

const ROWS: i64 = 50;

fn check(path: &std::path::Path) -> i64 {
    let (store, _) = Store::open(path).expect("a killed database must open");
    assert_eq!(store.integrity_check().unwrap(), "ok");
    let cursor: i64 = store.get("meta", "cursor").unwrap().map(|v| v.parse().unwrap()).unwrap_or(0);
    let rows = store.list("entities").unwrap();
    let mut per_page = std::collections::BTreeMap::<i64, i64>::new();
    for r in rows {
        let v: serde_json::Value = serde_json::from_str(&r).unwrap();
        *per_page.entry(v["page"].as_i64().unwrap()).or_default() += 1;
    }
    for page in 1..=cursor {
        assert_eq!(per_page.get(&page).copied(), Some(ROWS), "page {page} <= cursor {cursor} is incomplete");
    }
    assert!(per_page.keys().all(|p| *p <= cursor), "a row beyond the cursor {cursor} exists: {per_page:?}");
    cursor
}

#[test]
fn kill_nine_at_random_points_never_leaves_an_inconsistent_store() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("kill.db");
    let bin = env!("CARGO_BIN_EXE_store-crash-writer");
    let runs: u64 = std::env::var("ATLAS_KILL_RUNS").ok().and_then(|v| v.parse().ok()).unwrap_or(60);
    let mut last = 0;
    let mut advanced = 0;
    let mut seed = 0x9E3779B97F4A7C15u64;
    for _ in 0..runs {
        let mut child = Command::new(bin).arg(&path).arg(ROWS.to_string()).stdout(Stdio::null()).spawn().unwrap();
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        thread::sleep(Duration::from_millis(15 + seed % 120)); // includes mid-transaction kills
        child.kill().unwrap(); // SIGKILL on Unix, TerminateProcess on Windows
        child.wait().unwrap();
        let cursor = check(&path);
        assert!(cursor >= last, "the cursor went backwards: {cursor} < {last}");
        if cursor > last {
            advanced += 1;
        }
        last = cursor;
    }
    assert!(advanced as u64 >= runs * 9 / 10, "the writer made too little progress to prove anything: {advanced}/{runs}");
}
