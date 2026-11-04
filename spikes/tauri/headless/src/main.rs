//! Headless checks for SYNC-07 (S2 SQLite, S3 notes folder, S4 keystore). Prints JSON lines.
//! Usage: spike-headless <sqlite-bench|sqlite-kill|worker|migrate|notes-watch|notes-scan|keyring> <dir-or-path> [n]
use atlas_spike_core::{db, keystore, notes};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::mpsc::{channel, Receiver},
    time::{Duration, Instant},
};

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 1000.0 * 100.0).round() / 100.0
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let cmd = a.get(1).map(String::as_str).unwrap_or("");
    let path = PathBuf::from(a.get(2).cloned().unwrap_or_else(|| ".".into()));
    let n: usize = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(100);
    match cmd {
        "sqlite-bench" => sqlite_bench(&path),
        "sqlite-kill" => sqlite_kill(&path, n),
        "worker" => worker(&path),
        "migrate" => migrate(&path),
        "notes-watch" => notes_watch(&path),
        "notes-scan" => notes_scan(&path, n),
        "keyring" => keyring_check(),
        _ => {
            eprintln!("unknown command");
            std::process::exit(2);
        }
    }
}

fn sqlite_bench(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    let file = dir.join("bench.db");
    let _ = fs::remove_file(&file);
    let mut conn = db::open(&file, db::latest()).unwrap();
    let version = conn.query_row("select sqlite_version()", [], |r| r.get::<_, String>(0)).unwrap();
    let t = Instant::now();
    {
        let tx = conn.transaction().unwrap();
        {
            let mut st = tx.prepare("INSERT INTO items(batch,title,updated) VALUES(?1,?2,0)").unwrap();
            for i in 0..50_000 {
                st.execute(rusqlite::params![i / 50, format!("title-{:06}", i)]).unwrap();
            }
        }
        tx.commit().unwrap();
    }
    let insert = t.elapsed();
    let t = Instant::now();
    let found: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE title='title-031337'", [], |r| r.get(0)).unwrap();
    let q1 = t.elapsed();
    let t = Instant::now();
    let range: i64 = conn.query_row("SELECT COUNT(*) FROM items WHERE title BETWEEN 'title-010000' AND 'title-010999'", [], |r| r.get(0)).unwrap();
    let q2 = t.elapsed();
    // single-row commits (autocommit): the cost of one small durable write
    let t = Instant::now();
    for i in 0..200 {
        conn.execute("INSERT INTO meta(key,value) VALUES(?1,'x')", [format!("k{i}")]).unwrap();
    }
    let per_commit = ms(t.elapsed()) / 200.0;
    // apply_page: 50 rows + cursor
    let t = Instant::now();
    for b in 1..=100 {
        db::apply_page(&mut conn, 1000 + b, db::PAGE_ROWS).unwrap();
    }
    let per_page = ms(t.elapsed()) / 100.0;
    println!("{}", json!({"check":"S2.bench","sqlite":version,"synchronous":std::env::var("SPIKE_SYNC").unwrap_or("FULL".into()),
        "insert_50000_one_tx_ms":ms(insert),"indexed_point_query_ms":ms(q1),"found":found,"indexed_range_query_ms":ms(q2),"range_rows":range,
        "autocommit_single_row_ms_each":per_commit,"apply_page_50rows_plus_cursor_ms_each":per_page,"user_version":db::latest()}));
}

fn migrate(dir: &Path) {
    // Create at v1, insert, then open with v2 code: data kept, new column present.
    fs::create_dir_all(dir).unwrap();
    let file = dir.join("migrate.db");
    let _ = fs::remove_file(&file);
    {
        let c = db::open(&file, 1).unwrap();
        c.execute("INSERT INTO items(batch,title) VALUES(1,'old')", []).unwrap();
    }
    let c = db::open(&file, db::latest()).unwrap();
    let (title, updated): (String, i64) = c.query_row("SELECT title,updated FROM items", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    println!("{}", json!({"check":"S2.migrate","user_version":v,"title":title,"updated_default":updated}));
}

fn worker(file: &Path) {
    let mut conn = db::open(file, db::latest()).unwrap();
    loop {
        let next = db::cursor(&conn).unwrap() + 1;
        db::apply_page(&mut conn, next, db::PAGE_ROWS).unwrap();
    }
}

fn sqlite_kill(dir: &Path, iterations: usize) {
    fs::create_dir_all(dir).unwrap();
    let file = dir.join("kill.db");
    let _ = fs::remove_file(&file);
    let _ = fs::remove_file(dir.join("kill.db-wal"));
    let _ = fs::remove_file(dir.join("kill.db-shm"));
    drop(db::open(&file, db::latest()).unwrap());
    let exe = std::env::current_exe().unwrap();
    let mut seed: u64 = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64;
    let (mut bad, mut progressed, mut last) = (0, 0, 0i64);
    let mut details = vec![];
    for i in 0..iterations {
        let mut child = Command::new(&exe).arg("worker").arg(&file).spawn().unwrap();
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let delay = 15 + (seed >> 33) % 120; // ms after spawn: lands during startup, mid-transaction or between commits
        std::thread::sleep(Duration::from_millis(delay));
        child.kill().unwrap(); // SIGKILL
        child.wait().unwrap();
        let conn = db::open(&file, db::latest()).unwrap();
        match db::verify(&conn) {
            Ok(c) => {
                if c > last {
                    progressed += 1;
                }
                last = c;
            }
            Err(e) => {
                bad += 1;
                details.push(format!("iteration {i}: {e}"));
            }
        }
    }
    println!("{}", json!({"check":"S2.kill9","iterations":iterations,"inconsistent":bad,"runs_where_cursor_advanced":progressed,"final_cursor":last,"details":details}));
}

fn watch(root: &Path) -> (RecommendedWatcher, Receiver<(Instant, Event)>) {
    let (tx, rx) = channel();
    let mut w = RecommendedWatcher::new(
        move |res: notify::Result<Event>| {
            if let Ok(ev) = res {
                // Reading a file emits Access(Open/Close) events; reacting to them while reading
                // the changed file is a feedback loop (found by this spike). Ignore them.
                if matches!(ev.kind, notify::EventKind::Access(_)) {
                    return;
                }
                let _ = tx.send((Instant::now(), ev));
            }
        },
        Config::default(),
    )
    .unwrap();
    w.watch(root, RecursiveMode::Recursive).unwrap();
    (w, rx)
}

/// Wait up to 3 s for an event touching `needle`; returns latency in ms since `since`.
fn wait_for(rx: &Receiver<(Instant, Event)>, needle: &str, since: Instant) -> Option<f64> {
    let deadline = Instant::now() + Duration::from_secs(3);
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok((t, ev)) => {
                if ev.paths.iter().any(|p| p.to_string_lossy().ends_with(needle)) {
                    return Some(ms(t.saturating_duration_since(since)));
                }
            }
            Err(_) => return None,
        }
    }
    None
}

fn drain(rx: &Receiver<(Instant, Event)>) {
    while rx.recv_timeout(Duration::from_millis(300)).is_ok() {}
}

fn sh(root: &Path, script: &str) -> Instant {
    let st = Command::new("sh").arg("-c").arg(script).current_dir(root).status().unwrap();
    assert!(st.success(), "{script}");
    Instant::now()
}

fn notes_watch(root: &Path) {
    let _ = fs::remove_dir_all(root);
    fs::create_dir_all(root).unwrap();
    // 2000-file corpus + scan timing (S3 scan criterion)
    for d in 0..20 {
        fs::create_dir_all(root.join(format!("f{d:02}"))).unwrap();
        for i in 0..100 {
            fs::write(root.join(format!("f{d:02}/n{i:03}.md")), format!("# note {d} {i}\n\nbody\n")).unwrap();
        }
    }
    let t = Instant::now();
    let snapshot = notes::scan(root);
    let scan_ms = ms(t.elapsed());
    let root = root.canonicalize().unwrap();
    let (w, rx) = watch(&root);
    let mut rows = vec![];
    let mut run = |name: &str, script: &str, needle: &str| {
        drain(&rx);
        let start = Instant::now();
        let end = sh(&root, script);
        let lat = wait_for(&rx, needle, start);
        rows.push(json!({"scenario":name,"first_event_ms_after_command_start":lat,"command_took_ms":ms(end.duration_since(start))}));
    };
    run("create (shell redirect, VS Code/Obsidian-like in-place create)", "printf '# new\\n' > f00/new.md", "f00/new.md");
    run("modify in place (append)", "printf 'more\\n' >> f00/n001.md", "f00/n001.md");
    run("atomic replace (vim: write temp then mv over)", "printf 'v2\\n' > f00/.n002.md.swp; mv f00/.n002.md.swp f00/n002.md", "f00/n002.md");
    run("rename", "mv f00/n003.md f00/n003-renamed.md", "f00/n003-renamed.md");
    run("delete", "rm f00/n004.md", "f00/n004.md");
    run("new subfolder + file", "mkdir -p newdir && printf 'x\\n' > newdir/a.md", "newdir/a.md");
    // bulk change like `git checkout`: rewrite 200 files at once
    drain(&rx);
    let t0 = Instant::now();
    let _ = sh(&root, "for i in $(seq 0 99); do printf 'checkout\\n' > f05/n$(printf %03d $i).md; printf 'checkout\\n' > f06/n$(printf %03d $i).md; done");
    let mut seen = std::collections::BTreeSet::new();
    let mut last = 0.0;
    let deadline = Instant::now() + Duration::from_secs(5);
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left.min(Duration::from_millis(700))) {
            Ok((t, ev)) => {
                for p in ev.paths {
                    let s = p.to_string_lossy().into_owned();
                    if (s.contains("/f05/") || s.contains("/f06/")) && s.ends_with(".md") {
                        seen.insert(s);
                        last = ms(t.saturating_duration_since(t0));
                    }
                }
            }
            Err(_) => break,
        }
    }
    rows.push(json!({"scenario":"bulk 200-file rewrite (git checkout-like)","files_seen":seen.len(),"of":200,"last_event_ms_after_command_start":last}));
    // own atomic write must not loop
    drain(&rx);
    let before = notes::scan(&root);
    let content = b"# written by Atlas\n";
    notes::atomic_write(&root, "f01/own.md", content).unwrap();
    let mut total = 0;
    let mut after_filter = 0;
    let mut reconcile_actions = 0;
    while let Ok((_, ev)) = rx.recv_timeout(Duration::from_millis(400)) {
        for p in &ev.paths {
            total += 1;
            let name = p.file_name().unwrap().to_string_lossy();
            if name.starts_with(notes::TMP_MARK) || name.starts_with('.') {
                continue; // own temp files are ignored by name
            }
            after_filter += 1;
            if p.is_file() && fs::read(p).map(|b| b != content).unwrap_or(false) {
                reconcile_actions += 1; // only a content difference would trigger a reconcile
            }
        }
    }
    rows.push(json!({"scenario":"own atomic write (temp+rename)","events_total":total,"events_after_name_filter":after_filter,"reconcile_actions_after_hash_check":reconcile_actions,"scan_sees_new_file":notes::diff(&before,&notes::scan(&root)).added.len()}));
    println!("{}", json!({"check":"S3.watch","files":2000,"scan_2000_files_size_mtime_ms":scan_ms,"snapshot_len":snapshot.len(),"rows":rows,"backend":"notify RecommendedWatcher (inotify)"}));
    drop(w);

    // Watcher missed events: stop watching, change things, a scan must find every change.
    let old = notes::scan(&root);
    let t = Instant::now();
    sh(&root, "for i in 10 11 12 13 14 15 16 17 18 19; do printf 'changed content %s\\n' $i >> f07/n0$i.md; done; \
        for i in 20 21 22 23 24; do rm f07/n0$i.md; done; \
        for i in 1 2 3; do printf 'brand new\\n' > f07/added$i.md; done; \
        mv f08/n010.md f08/renamed010.md; \
        printf 'same-size-edit-AAAA' > f09/n000.md; touch -d '2020-01-01' f09/n000.md");
    let old2 = {
        // simulate "same size, same mtime" edit: record, then modify bytes preserving size and mtime
        let m = notes::scan(&root);
        sh(&root, "ts=$(stat -c %y f09/n000.md); printf 'same-size-edit-BBBB' > f09/n000.md; touch -d \"$ts\" f09/n000.md");
        m
    };
    let new = notes::scan(&root);
    let d = notes::diff(&old, &new);
    let d2 = notes::diff(&old2, &new);
    println!("{}", json!({"check":"S3.rescan","expected":{"modified":11,"removed":5+1,"added":3+1},
        "found":{"added":d.added.len(),"removed":d.removed.len(),"modified":d.modified.len()},"scan_ms":ms(t.elapsed()),
        "same_size_same_mtime_edit_detected_by_size_mtime_scan":!d2.modified.is_empty()}));
}

fn notes_scan(root: &Path, count: usize) {
    fs::create_dir_all(root).unwrap();
    for i in 0..count {
        let d = root.join(format!("d{:02}", i % 50));
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join(format!("n{i}.md")), "# n\n").unwrap();
    }
    let t = Instant::now();
    let s = notes::scan(root);
    println!("{}", json!({"check":"S3.scan","files":s.len(),"ms":ms(t.elapsed())}));
}

fn res<T: serde::Serialize>(r: Result<T, String>) -> serde_json::Value {
    match r {
        Ok(v) => json!({"ok": v}),
        Err(e) => json!({"err": e}),
    }
}

fn keyring_check() {
    let t = Instant::now();
    let set = res(keystore::set("atd_spike_not_a_real_token"));
    let set_ms = ms(t.elapsed());
    let r = json!({
        "set": set,
        "set_ms": set_ms,
        "get_equals": res(keystore::get().map(|v| v.as_deref() == Some("atd_spike_not_a_real_token"))),
        "exists": res(keystore::exists()),
        "delete": res(keystore::delete()),
        "exists_after_delete": res(keystore::exists()),
    });
    println!("{}", json!({"check":"S4.keyring","dbus_session_bus_address_set":std::env::var("DBUS_SESSION_BUS_ADDRESS").is_ok(),"result":r}));
}
