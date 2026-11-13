//! Android half of the shell (ADR-0075): commands over `tauri-plugin-atlas-android`. They exist on every target (the plugin is an
//! empty one off Android and answers `not_android`), so the command list and the capability file are the same everywhere.
use super::{AppHandle, Alarm, AtlasAndroid, CmdResult, Manager};
use serde_json::{json, Value};

type Plugin<'a> = tauri::State<'a, AtlasAndroid<tauri::Wry>>;

fn plugin(app: &AppHandle) -> Plugin<'_> {
    app.state::<AtlasAndroid<tauri::Wry>>()
}

#[cfg(not(desktop))]
pub fn notification_state(app: &AppHandle) -> CmdResult<String> {
    plugin(app).status().map(|s| s.notifications)
}

#[cfg(not(desktop))]
pub fn request_notifications(app: &AppHandle) -> CmdResult<String> {
    plugin(app).request_notifications()
}

/// Show now. `tag` is the fire key; its id is derived the same way as for scheduled ones so a later `clearShown` finds it.
#[cfg(not(desktop))]
pub fn show(app: &AppHandle, title: String, body: String, tag: Option<String>) -> CmdResult<()> {
    let id = tag.as_deref().map(stable_id).unwrap_or(1);
    plugin(app).show(&Alarm { id, at: 0, title, body, task_id: None, key: tag })
}

/// A stable positive 31-bit id from a string (FNV-1a), for notifications the core did not number itself.
#[cfg(not(desktop))]
fn stable_id(s: &str) -> i64 {
    let mut h: u32 = 0x811c9dc5;
    for b in s.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    (h & 0x7fff_ffff) as i64
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmArgs {
    id: i64,
    at: i64,
    title: String,
    body: String,
    task_id: Option<String>,
    key: Option<String>,
}

fn clip(s: String, max: usize) -> String {
    s.chars().take(max).collect()
}

#[tauri::command]
pub fn alarm_schedule(app: AppHandle, alarm: AlarmArgs) -> CmdResult<()> {
    if alarm.id < 0 || alarm.id > i32::MAX as i64 {
        return Err("bad_id".into());
    }
    plugin(&app).alarm_schedule(&Alarm {
        id: alarm.id,
        at: alarm.at,
        title: clip(alarm.title, 200),
        body: clip(alarm.body, 1000),
        task_id: alarm.task_id.map(|t| clip(t, 64)),
        key: alarm.key.map(|k| clip(k, 128)),
    })
}

#[tauri::command]
pub fn alarm_cancel(app: AppHandle, id: i64) -> CmdResult<()> {
    plugin(&app).alarm_cancel(id)
}

#[tauri::command]
pub fn alarm_list(app: AppHandle) -> CmdResult<Vec<Value>> {
    Ok(plugin(&app).alarm_list()?.into_iter().map(|(id, at)| json!({"id": id, "at": at})).collect())
}

#[tauri::command]
pub fn alarm_delivered(app: AppHandle) -> CmdResult<Vec<i64>> {
    plugin(&app).delivered()
}

#[tauri::command]
pub fn alarm_clear_shown(app: AppHandle, ids: Vec<i64>) -> CmdResult<()> {
    plugin(&app).clear_shown(&ids)
}

/// Notification permission, exact-alarm and battery-optimisation state for Settings and diagnostics (no content).
#[tauri::command]
pub fn android_status(app: AppHandle) -> CmdResult<Value> {
    let s = plugin(&app).status()?;
    Ok(json!({
        "notifications": s.notifications, "exactAlarms": s.exact_alarms,
        "ignoringBatteryOptimizations": s.ignoring_battery_optimizations, "allFilesAccess": s.all_files_access,
        "manufacturer": s.manufacturer, "sdk": s.sdk,
    }))
}

#[tauri::command]
pub fn android_open_settings(app: AppHandle, which: String) -> CmdResult<()> {
    if !["app", "notifications", "battery", "exact_alarms", "all_files"].contains(&which.as_str()) {
        return Err("bad_target".into());
    }
    plugin(&app).open_settings(&which)
}

/// The task id of a tapped reminder, once (the page navigates to it when it wakes).
#[tauri::command]
pub fn android_take_launch_task(app: AppHandle) -> CmdResult<Option<String>> {
    plugin(&app).take_launch_task()
}

/// The keystore backend over the plugin: Android Keystore (AES-GCM key that never leaves it), ciphertext in app-private storage.
#[cfg(target_os = "android")]
struct KeystoreBackend(AppHandle);

#[cfg(target_os = "android")]
impl atlas_desktop_native::keystore::Backend for KeystoreBackend {
    fn set(&self, token: &str) -> Result<(), String> {
        plugin(&self.0).token_set(token)
    }
    fn get(&self) -> Result<Option<String>, String> {
        plugin(&self.0).token_get()
    }
    fn delete(&self) -> Result<(), String> {
        plugin(&self.0).token_delete()
    }
}

#[cfg(target_os = "android")]
pub fn install_keystore(app: &AppHandle) {
    atlas_desktop_native::keystore::install(Box::new(KeystoreBackend(app.clone())));
}

/// Export the notes as one zip and hand it to Android's share sheet (the notes folder is private to the app, ADR-0075 D4, so this is how a
/// note leaves the phone as an ordinary Markdown file). Reads only through the confined notes folder; the zip lives in the app's cache and
/// the previous one is deleted first. Returns the counts, never the path.
#[tauri::command]
pub async fn notes_export(app: AppHandle, state: tauri::State<'_, super::AppState>) -> CmdResult<Value> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &state);
        Err("not_android".into())
    }
    #[cfg(target_os = "android")]
    {
        use std::io::Write;
        let folder = state.folder()?;
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("exports");
        let (path, files, bytes) = super::blocking(move || {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            for old in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
                if old.path().extension().is_some_and(|e| e == "zip") {
                    let _ = std::fs::remove_file(old.path());
                }
            }
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let path = dir.join(format!("atlas-notes-{stamp}.zip"));
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).map_err(|e| e.to_string())?);
            let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            let mut files = 0u64;
            for entry in folder.scan(false)?.into_iter().filter(|e| e.status == "ok") {
                let text = folder.read(&entry.path)?;
                zip.start_file(entry.path.as_str(), options).map_err(|e| e.to_string())?;
                zip.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
                files += 1;
            }
            zip.finish().map_err(|e| e.to_string())?;
            let bytes = std::fs::metadata(&path).map(|m| m.len()).map_err(|e| e.to_string())?;
            Ok((path, files, bytes))
        })
        .await?;
        plugin(&app).share_file(&path.to_string_lossy(), "application/zip", "Atlas notes")?;
        Ok(json!({"files": files, "bytes": bytes}))
    }
}

/// Where the notes live: `private` (inside the app) or `shared` (`Documents/Atlas Notes`, which other apps can open; needs the person to have
/// granted "All files access"). Display only: the webview never names a path.
#[tauri::command]
pub fn notes_location_get(app: AppHandle, state: tauri::State<'_, super::AppState>) -> CmdResult<Value> {
    let private = state.data_dir.join("notes");
    let current = state.folder.lock().unwrap().as_ref().map(|f| f.root().to_path_buf());
    let status = plugin(&app).status().ok();
    let shared_path = plugin(&app).shared_notes_path().ok();
    let kind = match (&current, &shared_path) {
        (Some(c), Some(s)) if c == std::path::Path::new(s) => "shared",
        _ => "private",
    };
    let _ = private;
    Ok(json!({
        "kind": kind,
        "sharedPath": shared_path,
        "allFilesAccess": status.map(|s| s.all_files_access).unwrap_or(false),
    }))
}

/// Move the notes to the other location: copy (never overwrite, never delete, verify; `notes::copy_notes`), then switch, then rename the old
/// folder ("... (previous <time>)"): nothing is ever deleted, so a wrong switch loses nothing. Refuses `shared` until "All files access" is granted.
#[tauri::command]
pub async fn notes_location_set(app: AppHandle, state: tauri::State<'_, super::AppState>, kind: String) -> CmdResult<Value> {
    use atlas_desktop_native::notes;
    let target_root = match kind.as_str() {
        "shared" => {
            if !plugin(&app).status()?.all_files_access {
                return Err("needs_all_files_access".into());
            }
            std::path::PathBuf::from(plugin(&app).shared_notes_path()?)
        }
        "private" => state.data_dir.join("notes"),
        _ => return Err("bad_location".into()),
    };
    let current = state.folder()?;
    let old_root = current.root().to_path_buf();
    if old_root == target_root {
        return Ok(json!({"copied": 0, "identical": 0, "switched": false, "archivedAs": null}));
    }
    std::fs::create_dir_all(&target_root).map_err(|e| e.to_string())?;
    let target = notes::Folder::new(&target_root)?;
    let report = super::blocking(move || notes::copy_notes(&current, &target)).await?;
    super::grant_root(&app, &state, target_root)?;
    // The old folder is renamed, never deleted, so that moving back later finds no stale copies to collide with (the copy refuses to
    // overwrite a different file) and the person can still look into it.
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let archived = old_root.file_name().map(|n| format!("{} (previous {stamp})", n.to_string_lossy())).and_then(|name| {
        let to = old_root.with_file_name(&name);
        std::fs::rename(&old_root, &to).ok().map(|_| name)
    });
    let _ = tauri::Emitter::emit(&app, "atlas-folder-changed", ());
    Ok(json!({"copied": report.copied, "identical": report.identical, "switched": true, "archivedAs": archived}))
}

/// The optional "keep Atlas connected" mode (a foreground service, ADR-0075 D7).
#[tauri::command]
pub fn keep_connected_get(app: AppHandle) -> CmdResult<bool> {
    plugin(&app).keep_connected_get()
}

#[tauri::command]
pub fn keep_connected_set(app: AppHandle, on: bool) -> CmdResult<()> {
    plugin(&app).keep_connected_set(on)
}
