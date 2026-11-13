//! Atlas Android host services (ADR-0075). The Kotlin half lives in `android/`; this crate is the typed Rust handle.
//!
//! Nothing here is a webview command: `src-tauri` calls these methods from its own commands, so the page can only do what the
//! shell allows. The device token is stored by `token_set` and read back by `token_get` for `http.rs` only; no command returns it.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;

/// One local reminder alarm. `text` fields are final (the core already chose generic or full content).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Alarm {
    pub id: i64,
    /// epoch ms
    pub at: i64,
    pub title: String,
    pub body: String,
    pub task_id: Option<String>,
    pub key: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `granted`, `denied` or `prompt`
    pub notifications: String,
    /// the OS lets this app set exact alarms (USE_EXACT_ALARM / SCHEDULE_EXACT_ALARM)
    pub exact_alarms: bool,
    /// the app is exempt from battery optimisation (Doze whitelist)
    pub ignoring_battery_optimizations: bool,
    /// "All files access" (needed only for the shared notes folder)
    #[serde(default)]
    pub all_files_access: bool,
    pub manufacturer: String,
    pub sdk: i64,
}

/// `invoke.resolve()` with no value answers JSON `null`; any value is accepted and ignored.
type Empty = serde_json::Value;
#[derive(Deserialize)]
struct Wrapped<T> {
    value: T,
}

/// The handle managed by the app. On targets other than Android every method fails with `not_android`.
pub struct AtlasAndroid<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> AtlasAndroid<R> {
    #[cfg(target_os = "android")]
    fn call<T: DeserializeOwned, P: Serialize>(&self, command: &str, payload: P) -> Result<T, String> {
        self.handle.run_mobile_plugin(command, payload).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    fn call<T: DeserializeOwned, P: Serialize>(&self, _command: &str, _payload: P) -> Result<T, String> {
        Err("not_android".into())
    }

    pub fn token_set(&self, token: &str) -> Result<(), String> {
        self.call::<Empty, _>("tokenSet", serde_json::json!({ "token": token })).map(|_| ())
    }
    /// Only `http.rs` (through the keystore backend) may call this; it is never exposed as a command.
    pub fn token_get(&self) -> Result<Option<String>, String> {
        self.call::<Wrapped<Option<String>>, _>("tokenGet", serde_json::json!({})).map(|w| w.value)
    }
    pub fn token_delete(&self) -> Result<(), String> {
        self.call::<Empty, _>("tokenDelete", serde_json::json!({})).map(|_| ())
    }
    pub fn alarm_schedule(&self, alarm: &Alarm) -> Result<(), String> {
        self.call::<Empty, _>("alarmSchedule", alarm).map(|_| ())
    }
    pub fn alarm_cancel(&self, id: i64) -> Result<(), String> {
        self.call::<Empty, _>("alarmCancel", serde_json::json!({ "id": id })).map(|_| ())
    }
    /// Alarms the OS (and our own store, re-armed after a reboot) still holds: `(id, at)`.
    pub fn alarm_list(&self) -> Result<Vec<(i64, i64)>, String> {
        #[derive(Deserialize)]
        struct Item {
            id: i64,
            at: i64,
        }
        self.call::<Wrapped<Vec<Item>>, _>("alarmList", serde_json::json!({})).map(|w| w.value.into_iter().map(|i| (i.id, i.at)).collect())
    }
    /// Ids delivered by the OS since the last call (also while the app was closed), plus those still in the shade. The log is cleared.
    pub fn delivered(&self) -> Result<Vec<i64>, String> {
        self.call::<Wrapped<Vec<i64>>, _>("delivered", serde_json::json!({})).map(|w| w.value)
    }
    pub fn show(&self, alarm: &Alarm) -> Result<(), String> {
        self.call::<Empty, _>("show", alarm).map(|_| ())
    }
    pub fn clear_shown(&self, ids: &[i64]) -> Result<(), String> {
        self.call::<Empty, _>("clearShown", serde_json::json!({ "ids": ids })).map(|_| ())
    }
    pub fn status(&self) -> Result<Status, String> {
        self.call("status", serde_json::json!({}))
    }
    /// Shows the Android 13+ permission prompt when needed; resolves with `granted`, `denied` or `prompt` (never hangs when granted).
    pub fn request_notifications(&self) -> Result<String, String> {
        self.call::<Wrapped<String>, _>("requestNotifications", serde_json::json!({})).map(|w| w.value)
    }
    /// Optional background mode (a foreground service with a visible notification keeps the app's connection alive); persisted by the plugin.
    pub fn keep_connected_set(&self, on: bool) -> Result<(), String> {
        self.call::<Empty, _>("keepConnectedSet", serde_json::json!({ "on": on })).map(|_| ())
    }
    pub fn keep_connected_get(&self) -> Result<bool, String> {
        self.call::<Wrapped<bool>, _>("keepConnectedGet", serde_json::json!({})).map(|w| w.value)
    }
    /// `Documents/Atlas Notes` on the primary shared storage.
    pub fn shared_notes_path(&self) -> Result<String, String> {
        self.call::<Wrapped<String>, _>("sharedNotesPath", serde_json::json!({})).map(|w| w.value)
    }
    /// The task a tapped notification asked to open, once.
    pub fn take_launch_task(&self) -> Result<Option<String>, String> {
        self.call::<Wrapped<Option<String>>, _>("takeLaunchTask", serde_json::json!({})).map(|w| w.value)
    }
    /// Opens the share sheet for a file in the app's cache (a content URI through the app's FileProvider; read access is granted for that one file).
    pub fn share_file(&self, path: &str, mime: &str, title: &str) -> Result<(), String> {
        self.call::<Empty, _>("shareFile", serde_json::json!({ "path": path, "mime": mime, "title": title })).map(|_| ())
    }
    /// `app`, `notifications`, `battery`, `exact_alarms` or `all_files`: opens that system settings screen.
    pub fn open_settings(&self, which: &str) -> Result<(), String> {
        self.call::<Empty, _>("openSettings", serde_json::json!({ "which": which })).map(|_| ())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("atlas-android")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin("app.atlas.android", "AtlasAndroidPlugin")?;
                app.manage(AtlasAndroid { handle });
            }
            #[cfg(not(target_os = "android"))]
            {
                app.manage(AtlasAndroid::<R> { _marker: std::marker::PhantomData });
            }
            Ok(())
        })
        .build()
}
