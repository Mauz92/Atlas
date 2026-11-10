//! The Atlas desktop shell (SYNC-09, ADR-0069): thin Tauri commands over `atlas-desktop-native`.
//!
//! Policy (what to sync, when, how to merge, when to notify) is TypeScript in `packages/desktop-core`, loaded by the
//! webview. This file only: owns the SQLite file, the keystore token, the granted notes folder and its watcher,
//! the tray and the window, and attaches the token to API requests. Every command is one line of glue where possible.
//!
//! Security posture (docs/SECURITY.md section 15): the webview loads only the bundled pages; it holds no token
//! (there is no command that returns it); the notes folder is chosen through a native dialog that the webview
//! cannot script and is the only place files are touched; `api_request` takes a path, never a URL.
use atlas_desktop_native::{http, keystore, notes, rules, store, watch};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

type CmdResult<T> = Result<T, String>;

#[derive(Default, Serialize, Deserialize, Clone)]
struct Config {
    base_url: Option<String>,
    device: Option<Value>,
    notes_root: Option<String>,
}

struct AppState {
    data_dir: PathBuf,
    store: Mutex<Option<store::Store>>,
    config: Mutex<Config>,
    folder: Mutex<Option<Arc<notes::Folder>>>,
    watcher: Mutex<Option<watch::FolderWatcher>>,
    close_to_tray: AtomicBool,
    quitting: AtomicBool,
}

impl AppState {
    fn save_config(&self) -> CmdResult<()> {
        let cfg = self.config.lock().unwrap().clone();
        let tmp = self.data_dir.join("config.json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&cfg).unwrap()).map_err(|e| e.to_string())?;
        fs::rename(&tmp, self.data_dir.join("config.json")).map_err(|e| e.to_string())
    }
    fn base_url(&self) -> CmdResult<String> {
        self.config.lock().unwrap().base_url.clone().ok_or_else(|| "not_signed_in".to_string())
    }
    fn folder(&self) -> CmdResult<Arc<notes::Folder>> {
        self.folder.lock().unwrap().clone().ok_or_else(|| "no_root".to_string())
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---- app ------------------------------------------------------------------------------------------

#[tauri::command]
fn app_info(app: AppHandle) -> Value {
    json!({
        "version": app.package_info().version.to_string(),
        "os": std::env::consts::OS,
        "updater": if cfg!(feature = "updater") { "configured" } else { "not_configured" },
    })
}

// ---- local database (SYNC-09a) --------------------------------------------------------------------

#[tauri::command]
fn db_open(state: State<AppState>) -> CmdResult<Value> {
    let mut guard = state.store.lock().unwrap();
    if guard.is_none() {
        let (s, v) = store::Store::open(&state.data_dir.join("atlas.db")).map_err(|e| e.to_string())?;
        *guard = Some(s);
        return Ok(json!({"schemaVersion": v}));
    }
    Ok(json!({"schemaVersion": guard.as_ref().unwrap().user_version().map_err(|e| e.to_string())?}))
}

fn with_store<T>(state: &State<AppState>, f: impl FnOnce(&mut store::Store) -> Result<T, store::StoreError>) -> CmdResult<T> {
    let mut guard = state.store.lock().unwrap();
    f(guard.as_mut().ok_or_else(|| store::StoreError::NotOpen.to_string())?).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_get(state: State<AppState>, table: String, key: String) -> CmdResult<Option<String>> {
    with_store(&state, |s| s.get(&table, &key))
}

#[tauri::command]
fn db_list(state: State<AppState>, table: String) -> CmdResult<Vec<String>> {
    with_store(&state, |s| s.list(&table))
}

#[tauri::command]
fn db_commit(state: State<AppState>, ops: Vec<store::Op>) -> CmdResult<()> {
    with_store(&state, |s| s.commit(&ops))
}

// ---- session and API (SYNC-09c): the token lives in the keystore and is attached here ----------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignInArgs {
    base_url: String,
    email: String,
    password: String,
    device_name: String,
}

#[tauri::command]
async fn session_sign_in(state: State<'_, AppState>, args: SignInArgs) -> CmdResult<Value> {
    match http::sign_in(&args.base_url, &args.email, &args.password, &args.device_name).await {
        Ok(device) => {
            let base = rules::check_base_url(&args.base_url)?;
            {
                let mut cfg = state.config.lock().unwrap();
                cfg.base_url = Some(base.clone());
                cfg.device = Some(device.clone());
            }
            state.save_config()?;
            Ok(json!({"ok": true, "device": device, "baseUrl": base}))
        }
        Err(f) => Ok(json!({"ok": false, "failure": f.failure, "detail": f.detail})),
    }
}

#[tauri::command]
async fn session_info(state: State<'_, AppState>) -> CmdResult<Value> {
    let cfg = state.config.lock().unwrap().clone();
    let token = blocking(keystore::exists).await;
    let (signed_in, key_err) = match token {
        Ok(has) => (has && cfg.base_url.is_some(), Value::Null),
        Err(e) => (false, json!(e)),
    };
    Ok(json!({"signedIn": signed_in, "baseUrl": if signed_in { json!(cfg.base_url) } else { Value::Null }, "device": if signed_in { cfg.device.unwrap_or(Value::Null) } else { Value::Null }, "keystoreError": key_err}))
}

async fn forget(state: &AppState) -> CmdResult<()> {
    blocking(keystore::delete).await?;
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.base_url = None;
        cfg.device = None;
    }
    state.save_config()
}

#[tauri::command]
async fn session_clear(state: State<'_, AppState>) -> CmdResult<()> {
    forget(&state).await
}

#[tauri::command]
async fn session_sign_out(state: State<'_, AppState>) -> CmdResult<()> {
    if let Ok(base) = state.base_url() {
        // best effort: revoke this device on the server; offline or already revoked must not block signing out
        let req = http::ApiRequest { method: "DELETE".into(), path: "/api/devices/current".into(), headers: Default::default(), body: None, timeout_ms: Some(8_000) };
        let _ = http::request(&base, &req).await;
    }
    forget(&state).await
}

#[tauri::command]
async fn api_request(app: AppHandle, state: State<'_, AppState>, req: http::ApiRequest) -> CmdResult<http::ApiResponse> {
    let base = state.base_url()?;
    let resp = http::request(&base, &req).await?;
    if resp.status == 401 || resp.status == 426 {
        let _ = app.emit("atlas-auth", resp.status);
    }
    Ok(resp)
}

// ---- notes folder (SYNC-09b) ------------------------------------------------------------------------

fn grant_root(app: &AppHandle, state: &AppState, root: PathBuf) -> CmdResult<String> {
    let folder = Arc::new(notes::Folder::new(&root)?);
    let shown = folder.root().to_string_lossy().into_owned();
    let handle = app.clone();
    let watcher = watch::FolderWatcher::start(folder.root(), Duration::from_millis(250), Arc::new(move || {
        let _ = handle.emit("atlas-folder-changed", ());
    }))
    .map_err(|e| format!("watcher: {e}"))?;
    *state.watcher.lock().unwrap() = Some(watcher);
    *state.folder.lock().unwrap() = Some(folder);
    state.config.lock().unwrap().notes_root = Some(shown.clone());
    state.save_config()?;
    Ok(shown)
}

#[tauri::command]
fn folder_root(state: State<AppState>) -> Option<String> {
    state.folder.lock().unwrap().as_ref().map(|f| f.root().to_string_lossy().into_owned())
}

/// The native folder dialog. The webview cannot pass a path: this is the only way a root is ever granted.
#[tauri::command]
async fn folder_choose(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Option<String>> {
    #[cfg(feature = "e2e")]
    if let Ok(root) = std::env::var("ATLAS_E2E_NOTES_ROOT") {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        return grant_root(&app, &state, PathBuf::from(root)).map(Some);
    }
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().set_title("Choose your Atlas notes folder").pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let picked = blocking(move || rx.recv().map_err(|e| e.to_string())).await?;
    match picked {
        None => Ok(None),
        Some(p) => {
            let path = p.into_path().map_err(|e| e.to_string())?;
            grant_root(&app, &state, path).map(Some)
        }
    }
}

#[tauri::command]
async fn folder_scan(state: State<'_, AppState>, full: bool) -> CmdResult<Vec<notes::Entry>> {
    let f = state.folder()?;
    blocking(move || f.scan(full)).await
}

#[tauri::command]
async fn folder_read(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    let f = state.folder()?;
    blocking(move || f.read(&path)).await
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ExpectedArg {
    Absent,
    Hash { hash: String },
}

#[tauri::command]
async fn folder_write(state: State<'_, AppState>, path: String, content: String, expected: ExpectedArg) -> CmdResult<Value> {
    let f = state.folder()?;
    let exp = match expected {
        ExpectedArg::Absent => notes::Expected::Absent,
        ExpectedArg::Hash { hash } => notes::Expected::Hash(hash),
    };
    blocking(move || {
        Ok(match f.write(&path, &content, &exp)? {
            notes::WriteOutcome::Written(hash) => json!({"result": "written", "hash": hash}),
            notes::WriteOutcome::Changed => json!({"result": "changed"}),
            notes::WriteOutcome::Exists => json!({"result": "exists"}),
        })
    })
    .await
}

fn move_word(o: notes::MoveOutcome, done: &str) -> Value {
    json!(match o {
        notes::MoveOutcome::Done => done,
        notes::MoveOutcome::Changed => "changed",
        notes::MoveOutcome::Exists => "exists",
        notes::MoveOutcome::Missing => "missing",
    })
}

#[tauri::command]
async fn folder_rename(state: State<'_, AppState>, from: String, to: String, expected_hash: String) -> CmdResult<Value> {
    let f = state.folder()?;
    blocking(move || Ok(move_word(f.rename(&from, &to, &expected_hash)?, "renamed"))).await
}

#[tauri::command]
async fn folder_trash(state: State<'_, AppState>, path: String, expected_hash: String) -> CmdResult<Value> {
    let f = state.folder()?;
    blocking(move || Ok(move_word(f.trash(&path, &expected_hash)?, "trashed"))).await
}

// ---- notifications, tray, autostart, window -----------------------------------------------------------

#[tauri::command]
fn notify_permission(app: AppHandle) -> CmdResult<String> {
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    Ok(match app.notification().permission_state().map_err(|e| e.to_string())? {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        _ => "default",
    }
    .into())
}

#[tauri::command]
fn notify_request_permission(app: AppHandle) -> CmdResult<String> {
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    Ok(match app.notification().request_permission().map_err(|e| e.to_string())? {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        _ => "default",
    }
    .into())
}

fn clip(s: String, max: usize) -> String {
    s.chars().take(max).collect()
}

#[tauri::command]
fn notify_show(app: AppHandle, title: String, body: String) -> CmdResult<()> {
    use tauri_plugin_notification::NotificationExt;
    app.notification().builder().title(clip(title, 200)).body(clip(body, 1000)).show().map_err(|e| e.to_string())
}

#[tauri::command]
fn tray_set_close_to_tray(state: State<AppState>, enabled: bool) {
    state.close_to_tray.store(enabled, Ordering::SeqCst);
}

#[tauri::command]
fn tray_set_status(app: AppHandle, text: String) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(clip(format!("Atlas: {text}"), 100)));
    }
}

#[tauri::command]
fn autostart_is_enabled(app: AppHandle) -> CmdResult<bool> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_set_enabled(app: AppHandle, enabled: bool) -> CmdResult<()> {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    if enabled { m.enable() } else { m.disable() }.map_err(|e| e.to_string())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn window_show(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
fn app_quit(app: AppHandle, state: State<AppState>) {
    state.quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

// ---- updates (SYNC-09e): compiled only with the `updater` feature, which no default build enables ---------

#[allow(clippy::needless_return)]
#[tauri::command]
async fn update_check(app: AppHandle, install: bool) -> CmdResult<Value> {
    #[cfg(feature = "updater")]
    {
        use tauri_plugin_updater::UpdaterExt;
        let updater = app.updater().map_err(|e| e.to_string())?;
        return match updater.check().await.map_err(|e| e.to_string())? {
            None => Ok(json!({"available": null})),
            Some(update) => {
                let version = update.version.clone();
                if install {
                    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
                    return Ok(json!({"available": version, "installed": true}));
                }
                Ok(json!({"available": version}))
            }
        };
    }
    #[cfg(not(feature = "updater"))]
    {
        let _ = (app, install);
        Err("not_configured".into())
    }
}

// ---- test hooks (feature `e2e`, never in a build given to a person) ----------------------------------------

#[cfg(feature = "e2e")]
fn out_dir() -> PathBuf {
    std::env::var_os("ATLAS_E2E_OUT").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("atlas-e2e-out"))
}

#[allow(clippy::needless_return)]
#[tauri::command]
fn e2e_report(name: String, value: Value) -> CmdResult<()> {
    #[cfg(feature = "e2e")]
    {
        let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
        fs::create_dir_all(out_dir()).map_err(|e| e.to_string())?;
        return fs::write(out_dir().join(format!("{safe}.json")), serde_json::to_vec_pretty(&value).unwrap()).map_err(|e| e.to_string());
    }
    #[cfg(not(feature = "e2e"))]
    {
        let _ = (name, value);
        Err("not available".into())
    }
}

#[allow(clippy::needless_return)]
#[tauri::command]
fn e2e_window_state(app: AppHandle) -> CmdResult<Value> {
    #[cfg(feature = "e2e")]
    {
        let w = app.get_webview_window("main").ok_or("no window")?;
        return Ok(json!({"visible": w.is_visible().unwrap_or(false), "focused": w.is_focused().unwrap_or(false), "pid": std::process::id()}));
    }
    #[cfg(not(feature = "e2e"))]
    {
        let _ = app;
        Err("not available".into())
    }
}

#[allow(clippy::needless_return)]
#[tauri::command]
fn e2e_tray(app: AppHandle, item: String) -> CmdResult<()> {
    #[cfg(feature = "e2e")]
    {
        handle_tray_item(&app, &item);
        return Ok(());
    }
    #[cfg(not(feature = "e2e"))]
    {
        let _ = (app, item);
        Err("not available".into())
    }
}

#[allow(clippy::needless_return)]
#[tauri::command]
fn e2e_close_window(app: AppHandle) -> CmdResult<()> {
    #[cfg(feature = "e2e")]
    {
        return app.get_webview_window("main").ok_or("no window")?.close().map_err(|e| e.to_string());
    }
    #[cfg(not(feature = "e2e"))]
    {
        let _ = app;
        Err("not available".into())
    }
}

#[allow(clippy::needless_return)]
#[tauri::command]
fn e2e_exit(app: AppHandle) -> CmdResult<()> {
    #[cfg(feature = "e2e")]
    {
        app.exit(0);
        return Ok(());
    }
    #[cfg(not(feature = "e2e"))]
    {
        let _ = app;
        Err("not available".into())
    }
}

// ---- tray and application setup -------------------------------------------------------------------------------

fn handle_tray_item(app: &AppHandle, id: &str) {
    match id {
        "open" => {
            show_main(app);
            let _ = app.emit("atlas-tray", "open");
        }
        "sync_now" => {
            let _ = app.emit("atlas-tray", "sync_now");
        }
        "quit" => {
            if let Some(s) = app.try_state::<AppState>() {
                s.quitting.store(true, Ordering::SeqCst);
            }
            app.exit(0);
        }
        _ => {}
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Open Atlas", true, None::<&str>)?,
            &MenuItem::with_id(app, "sync_now", "Sync now", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit Atlas (reminders stop)", true, None::<&str>)?,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id("main").tooltip("Atlas").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(|app, event| handle_tray_item(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                handle_tray_item(tray.app_handle(), "open");
            }
        })
        .build(app)?;
    Ok(())
}

/// WebKitGTK 2.54 on an NVIDIA GPU dies with `Gdk Error 71` (Wayland) or `Failed to create GBM buffer` (Xwayland)
/// unless the DMA-BUF renderer is off (SYNC-07 S9, R-58). Set it before the webview exists, only when the
/// proprietary NVIDIA driver is loaded and the user did not decide otherwise. `ATLAS_KEEP_DMABUF=1` opts out.
#[cfg(target_os = "linux")]
fn webkit_environment() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::env::var_os("ATLAS_KEEP_DMABUF").is_none()
        && std::path::Path::new("/proc/driver/nvidia/version").exists()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

pub fn run() {
    #[cfg(target_os = "linux")]
    webkit_environment();
    let background = std::env::args().any(|a| a == "--background");

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--background"])));
    #[cfg(feature = "updater")]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .invoke_handler(tauri::generate_handler![
            app_info, db_open, db_get, db_list, db_commit, session_sign_in, session_info, session_clear, session_sign_out, api_request,
            folder_root, folder_choose, folder_scan, folder_read, folder_write, folder_rename, folder_trash,
            notify_permission, notify_request_permission, notify_show, tray_set_close_to_tray, tray_set_status,
            autostart_is_enabled, autostart_set_enabled, window_show, app_quit, update_check,
            e2e_report, e2e_window_state, e2e_tray, e2e_close_window, e2e_exit
        ])
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    if state.close_to_tray.load(Ordering::SeqCst) && !state.quitting.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
            WindowEvent::Focused(true) => {
                let _ = window.app_handle().emit("atlas-wake", ());
            }
            _ => {}
        })
        .setup(move |app| {
            let data_dir = std::env::var_os("ATLAS_DESKTOP_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| app.path().app_data_dir().expect("app data dir"));
            fs::create_dir_all(&data_dir)?;
            // the database holds the user's tasks and note text: only the user may read the directory (T14)
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&data_dir, fs::Permissions::from_mode(0o700))?;
            }
            let config: Config = fs::read(data_dir.join("config.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            let state = AppState {
                data_dir,
                store: Mutex::new(None),
                config: Mutex::new(config.clone()),
                folder: Mutex::new(None),
                watcher: Mutex::new(None),
                close_to_tray: AtomicBool::new(true),
                quitting: AtomicBool::new(false),
            };
            app.manage(state);
            // a root granted in an earlier run is opened again (never one the webview names)
            if let Some(root) = config.notes_root.as_deref() {
                let handle = app.handle().clone();
                let st = handle.state::<AppState>();
                if let Err(e) = grant_root(&handle, &st, PathBuf::from(root)) {
                    eprintln!("notes folder not reopened: {e}");
                }
            }
            build_tray(app.handle())?;
            let signed_config = config.base_url.is_some();
            #[allow(unused_mut)]
            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("welcome.html".into()))
                .title("Atlas")
                .inner_size(1200.0, 800.0)
                .min_inner_size(420.0, 520.0)
                .visible(!(background && signed_config));
            #[cfg(feature = "e2e")]
            if let Some(path) = std::env::var_os("ATLAS_E2E_SCRIPT") {
                window = window.initialization_script(fs::read_to_string(path)?);
            }
            window.build()?;
            #[cfg(feature = "e2e")]
            {
                // the end-to-end orchestrator drops `command.json` into the output directory; it is forwarded to the page
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_millis(200));
                    let file = out_dir().join("command.json");
                    if let Ok(bytes) = fs::read(&file) {
                        let _ = fs::remove_file(&file);
                        if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                            let _ = handle.emit("e2e-command", v);
                        }
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Atlas desktop app");
}
