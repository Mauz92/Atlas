//! Writes "pages" of rows plus a cursor, each page in ONE `Store::commit`, until it is killed.
//! The kill-9 durability test (`tests/store_kill.rs`) starts it, kills it at a random moment and checks the file.
//! Usage: store-crash-writer <db> <rows-per-page>
use atlas_desktop_native::store::{Op, Store, Synchronous};
use std::path::PathBuf;

fn main() {
    let path = PathBuf::from(std::env::args().nth(1).expect("db path"));
    let rows: i64 = std::env::args().nth(2).and_then(|v| v.parse().ok()).unwrap_or(50);
    let sync = if std::env::var("CRASH_WRITER_SYNC").as_deref() == Ok("NORMAL") { Synchronous::Normal } else { Synchronous::Full };
    let (mut store, _) = Store::open_with(&path, sync).expect("open");
    let start: i64 = store.get("meta", "cursor").unwrap().map(|v| v.parse().unwrap()).unwrap_or(0);
    println!("started at {start}");
    for page in (start + 1)..i64::MAX {
        let mut ops: Vec<Op> = (0..rows)
            .map(|i| Op::Put { table: "entities".into(), key: format!("p{page}-r{i}"), value: format!("{{\"page\":{page},\"row\":{i}}}"), ord: Some(page), kind: Some("task".into()) })
            .collect();
        ops.push(Op::Put { table: "meta".into(), key: "cursor".into(), value: page.to_string(), ord: None, kind: None });
        store.commit(&ops).expect("commit");
    }
}
