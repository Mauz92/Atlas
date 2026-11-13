//! SYNC-07 spike shell. Small on purpose: commands are the ones a real client would need
//! (SQLite, notes folder, keystore, API proxy with the token attached in Rust), plus test helpers
//! (`report`, `snapshot`, `exit_app`) that are NOT part of a product build.
use atlas_spike_core::{db, keystore, notes};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
struct AppState {
    db: Mutex<Option<atlas_spike_core::rusqlite::Connection>>,
    api_base: Mutex<Option<String>>,
    notes_root: Mutex<Option<PathBuf>>,
}

fn out_dir() -> PathBuf {
    std::env::var_os("SPIKE_OUT").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("atlas-spike-out"))
}

fn sanitize(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

fn write_report(name: &str, value: &Value) -> Result<(), String> {
    let d = out_dir();
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    fs::write(d.join(format!("{}.json", sanitize(name))), serde_json::to_vec_pretty(value).unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
fn report(name: String, value: Value) -> Result<(), String> {
    write_report(&name, &value)
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn ctx(app: tauri::AppHandle) -> Value {
    #[cfg(target_os = "linux")]
    let webkit = format!(
        "{}.{}.{}",
        unsafe { webkit2gtk::ffi::webkit_get_major_version() },
        unsafe { webkit2gtk::ffi::webkit_get_minor_version() },
        unsafe { webkit2gtk::ffi::webkit_get_micro_version() }
    );
    #[cfg(not(target_os = "linux"))]
    let webkit = "n/a".to_string();
    json!({"os": std::env::consts::OS, "arch": std::env::consts::ARCH, "webkitgtk": webkit, "tauri": tauri::VERSION,
           "app_version": app.package_info().version.to_string(), "pid": std::process::id(),
           "cfg": {"suite": std::env::var("SPIKE_SUITE").ok(), "delay": std::env::var("SPIKE_DELAY").ok(), "idle": std::env::var("SPIKE_IDLE").ok(), "nid": std::env::var("SPIKE_NID").ok(), "api": std::env::var("SPIKE_API").ok(), "notes": std::env::var("SPIKE_NOTES").ok(),
                   "db": std::env::var("SPIKE_DB").ok(), "https_base": std::env::var("SPIKE_HTTPS_BASE").ok(), "email": std::env::var("SPIKE_EMAIL").ok(), "password": std::env::var("SPIKE_PASSWORD").ok()}})
}

#[tauri::command]
async fn snapshot(window: tauri::WebviewWindow, name: String) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};
        let dir = out_dir().join("shots");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("{}.png", sanitize(&name)));
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let p = path.clone();
        window
            .with_webview(move |wv| {
                wv.inner().snapshot(SnapshotRegion::Visible, SnapshotOptions::NONE, None::<&gtk::gio::Cancellable>, move |res| {
                    let r = res.map_err(|e| e.to_string()).and_then(|surface| {
                        let img = gtk::cairo::ImageSurface::try_from(surface).map_err(|_| "not an image surface".to_string())?;
                        let mut f = fs::File::create(&p).map_err(|e| e.to_string())?;
                        img.write_to_png(&mut f).map_err(|e| e.to_string())
                    });
                    let _ = tx.send(r);
                });
            })
            .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(10)).map_err(|e| e.to_string())?)
            .await
            .map_err(|e| e.to_string())??;
        Ok(path.to_string_lossy().into_owned())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, name);
        Err("snapshot is only implemented on Linux in this spike".into())
    }
}

// ---- SQLite (S2) -------------------------------------------------------------------------------

#[tauri::command]
fn db_open(state: State<AppState>, path: String) -> Result<i64, String> {
    let c = db::open(Path::new(&path), db::latest()).map_err(|e| e.to_string())?;
    let v = c.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|e: atlas_spike_core::rusqlite::Error| e.to_string())?;
    *state.db.lock().unwrap() = Some(c);
    Ok(v)
}

fn with_db<T>(state: &State<AppState>, f: impl FnOnce(&mut atlas_spike_core::rusqlite::Connection) -> atlas_spike_core::rusqlite::Result<T>) -> Result<T, String> {
    let mut g = state.db.lock().unwrap();
    f(g.as_mut().ok_or("database not open")?).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_ping(state: State<AppState>) -> Result<i64, String> {
    with_db(&state, |c| c.query_row("SELECT 1", [], |r| r.get(0)))
}

#[tauri::command]
fn db_apply_page(state: State<AppState>, batch: i64, rows: i64) -> Result<(), String> {
    with_db(&state, |c| db::apply_page(c, batch, rows))
}

#[tauri::command]
fn db_cursor(state: State<AppState>) -> Result<i64, String> {
    with_db(&state, |c| db::cursor(c))
}

#[tauri::command]
fn kv_read(state: State<AppState>, key: String) -> Result<Option<String>, String> {
    with_db(&state, |c| db::kv_read(c, &key))
}

#[tauri::command]
fn kv_write(state: State<AppState>, key: String, value: String) -> Result<(), String> {
    with_db(&state, |c| db::kv_write(c, &key, &value))
}

#[tauri::command]
fn kv_remove(state: State<AppState>, key: String) -> Result<(), String> {
    with_db(&state, |c| db::kv_remove(c, &key))
}

// ---- keystore (S4): there is deliberately no command that returns the token --------------------

#[tauri::command]
fn token_set(token: String) -> Result<(), String> {
    keystore::set(&token)
}

#[tauri::command]
fn token_exists() -> Result<bool, String> {
    keystore::exists()
}

#[tauri::command]
fn token_delete() -> Result<(), String> {
    keystore::delete()
}

// ---- API access with the token attached in Rust (S4, S9) ---------------------------------------

fn check_scheme(url: &reqwest::Url) -> Result<(), String> {
    let loopback = matches!(url.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"));
    if url.scheme() == "https" || (url.scheme() == "http" && loopback) {
        Ok(())
    } else {
        Err(format!("refused: {}://{} (https only, http only for loopback)", url.scheme(), url.host_str().unwrap_or("")))
    }
}

#[derive(Deserialize)]
struct DeviceCreds {
    base: String,
    email: String,
    password: String,
    name: String,
}

#[tauri::command]
async fn device_sign_in(state: State<'_, AppState>, creds: DeviceCreds) -> Result<Value, String> {
    let url = reqwest::Url::parse(&format!("{}/api/devices", creds.base.trim_end_matches('/'))).map_err(|e| e.to_string())?;
    check_scheme(&url)?;
    let resp = reqwest::Client::new()
        .post(url)
        .json(&json!({"email": creds.email, "password": creds.password, "name": creds.name, "platform": "linux"}))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    if status != 201 {
        return Err(format!("sign-in failed: {status}"));
    }
    let token = body["token"].as_str().ok_or("no token in response")?.to_string();
    tauri::async_runtime::spawn_blocking(move || keystore::set(&token)).await.map_err(|e| e.to_string())??;
    *state.api_base.lock().unwrap() = Some(creds.base.trim_end_matches('/').to_string());
    Ok(body["device"].clone()) // the token itself never reaches the webview
}

#[derive(Deserialize)]
struct ApiReq {
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
}

#[derive(Serialize)]
struct ApiResp {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

#[tauri::command]
async fn api_request(state: State<'_, AppState>, req: ApiReq) -> Result<ApiResp, String> {
    let url = reqwest::Url::parse(&req.url).map_err(|e| e.to_string())?;
    check_scheme(&url)?;
    let base = state.api_base.lock().unwrap().clone().ok_or("no device signed in")?;
    let base_url = reqwest::Url::parse(&base).map_err(|e| e.to_string())?;
    if url.origin() != base_url.origin() {
        return Err("refused: not the configured Atlas origin".into());
    }
    let token = tauri::async_runtime::spawn_blocking(keystore::get).await.map_err(|e| e.to_string())??;
    let method = reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|e| e.to_string())?;
    let mut rb = reqwest::Client::new().request(method, url);
    for (k, v) in &req.headers {
        if !k.eq_ignore_ascii_case("authorization") {
            rb = rb.header(k, v); // the webview-supplied Authorization (a placeholder) is dropped
        }
    }
    if let Some(t) = token {
        rb = rb.bearer_auth(t);
    }
    if let Some(b) = req.body {
        rb = rb.body(b);
    }
    let resp = rb.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let headers = resp.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(ApiResp { status, headers, body })
}

// ---- notes folder (S3) -------------------------------------------------------------------------

#[tauri::command]
fn grant_notes_folder(app: tauri::AppHandle, state: State<AppState>, path: String) -> Result<(), String> {
    // In a product this is called with the folder returned by the native dialog, never with a
    // path the webview made up. The fs plugin scope is extended at RUNTIME for that folder only.
    use tauri_plugin_fs::FsExt;
    let p = PathBuf::from(&path).canonicalize().map_err(|e| e.to_string())?;
    app.fs_scope().allow_directory(&p, true).map_err(|e| e.to_string())?;
    *state.notes_root.lock().unwrap() = Some(p);
    Ok(())
}

fn root(state: &State<AppState>) -> Result<PathBuf, String> {
    state.notes_root.lock().unwrap().clone().ok_or_else(|| "no notes folder granted".into())
}

#[tauri::command]
fn notes_atomic_write(state: State<AppState>, rel: String, content: String) -> Result<(), String> {
    notes::atomic_write(&root(&state)?, &rel, content.as_bytes())
}

#[tauri::command]
fn notes_scan(state: State<AppState>) -> Result<usize, String> {
    Ok(notes::scan(&root(&state)?).len())
}

// ---- notifications (S5) ------------------------------------------------------------------------

#[tauri::command]
fn notify_test(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification().builder().title("Atlas spike").body("SYNC-07 notification check (local, no server)").show().map_err(|e| e.to_string())
}

/// Probe used to show that a command exists but is not granted to a window.
#[tauri::command]
fn window_eval_probe() -> &'static str {
    "granted"
}

async fn tokio_sleep(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await;
}


/// Android: there are no environment variables on a phone. The host pushes `files/spike.json` with
/// `adb shell run-as app.atlas.spike` and its keys become the SPIKE_* variables the harness already reads.
/// Reports go to `files/out/` (read back with `run-as ... cat`). Spike/debug builds only.
#[cfg(target_os = "android")]
fn android_config(app: &tauri::App) -> Option<String> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = fs::create_dir_all(dir.join("out"));
    std::env::set_var("SPIKE_OUT", dir.join("out"));
    std::env::set_var("SPIKE_DB", dir.join("ipc.db"));
    let cfg: Value = serde_json::from_slice(&fs::read(dir.join("spike.json")).ok()?).ok()?;
    for (k, v) in cfg.as_object()? {
        if let Some(v) = v.as_str() {
            std::env::set_var(format!("SPIKE_{}", k.to_uppercase()), v);
        }
    }
    Some(dir.display().to_string())
}

/// S2 on Android: a worker thread commits pages in a loop. The host force-stops the app at random moments; every start
/// first verifies the database (integrity + page/row consistency) and appends the verdict to `out/kill.log`.
#[cfg(target_os = "android")]
fn killtest(dir: PathBuf) {
    use std::io::Write;
    std::thread::spawn(move || {
        let file = dir.join("kill.db");
        let log = dir.join("out").join("kill.log");
        let line = |s: String| {
            if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&log) {
                let _ = writeln!(f, "{s}");
            }
        };
        let mut conn = match atlas_spike_core::db::open(&file, atlas_spike_core::db::latest()) {
            Ok(c) => c,
            Err(e) => return line(format!("OPEN_FAILED {e}")),
        };
        match atlas_spike_core::db::verify(&conn) {
            Ok(c) => line(format!("OK cursor={c}")),
            Err(e) => line(format!("INCONSISTENT {e}")),
        }
        loop {
            let next = atlas_spike_core::db::cursor(&conn).unwrap_or(0) + 1;
            if atlas_spike_core::db::apply_page(&mut conn, next, atlas_spike_core::db::PAGE_ROWS).is_err() {
                return line("APPLY_FAILED".into());
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let _ = write_report("single-instance", &json!({"second_instance_args": args, "cwd": cwd, "app_pid": std::process::id()}));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            report, snapshot, exit_app, ctx, db_open, db_ping, db_apply_page, db_cursor, kv_read, kv_write, kv_remove, token_set,
            token_exists, token_delete, device_sign_in, api_request, grant_notes_folder, notes_atomic_write, notes_scan, notify_test,
            window_eval_probe
        ])
        .setup(|app| {
            #[cfg(target_os = "android")]
            if let Some(d) = android_config(app) {
                if std::env::var("SPIKE_SUITE").map(|s| s.contains("killtest")).unwrap_or(false) {
                    killtest(PathBuf::from(d));
                }
            }
            let suite = std::env::var("SPIKE_SUITE").unwrap_or_default();
            if std::env::var("SPIKE_ATLAS_URL").is_err() && suite != "updater" {
                let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into())).title("Atlas spike harness").inner_size(1100.0, 760.0);
                if suite == "embedded" {
                    b = b.initialization_script(include_str!("../../ui/embedded-probe.js"));
                }
                let win = b.build()?;
                if suite == "embedded" {
                    let h = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        tokio_sleep(7000).await;
                        let r = snapshot(win, "embedded-ui".into()).await;
                        let _ = write_report("embedded-snapshot", &json!({"result": format!("{r:?}")}));
                        h.exit(0);
                    });
                }
            }
            if let Ok(url) = std::env::var("SPIKE_ATLAS_URL") {
                let (w, h) = std::env::var("SPIKE_ATLAS_SIZE")
                    .ok()
                    .and_then(|s| s.split_once('x').and_then(|(a, b)| Some((a.parse::<f64>().ok()?, b.parse::<f64>().ok()?))))
                    .unwrap_or((1280.0, 800.0));
                let script = format!("{}\n{}", include_str!("../../ui/scenario.js"), include_str!("../../ui/atlas-driver.js"));
                WebviewWindowBuilder::new(app, "atlas", WebviewUrl::External(url.parse().expect("SPIKE_ATLAS_URL")))
                    .title("Atlas (spike, WebKitGTK)")
                    .inner_size(w, h)
                    .initialization_script(script)
                    .build()?;
            }
            #[cfg(desktop)]
            if suite == "updater" {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_updater::UpdaterExt;
                    let mut out = json!({"current": h.package_info().version.to_string()});
                    match h.updater() {
                        Err(e) => out["error"] = json!(format!("{e}")),
                        Ok(u) => match u.check().await {
                            Ok(Some(update)) => {
                                out["available"] = json!(update.version.clone());
                                match update.download_and_install(|_, _| {}, || {}).await {
                                    Ok(()) => out["install"] = json!("ok"),
                                    Err(e) => out["install_error"] = json!(format!("{e}")),
                                }
                            }
                            Ok(None) => out["available"] = Value::Null,
                            Err(e) => out["check_error"] = json!(format!("{e}")),
                        },
                    }
                    let _ = write_report("updater", &out);
                    h.exit(0);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Atlas spike");
}
