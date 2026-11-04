// Every app command needs an explicit permission (`allow-<command>`): the capability files grant them
// per window, so a remote origin cannot call commands it was not given.
fn main() {
    let commands = &[
        "report", "snapshot", "exit_app", "ctx", "db_open", "db_ping", "db_apply_page", "db_cursor", "kv_read", "kv_write",
        "kv_remove", "token_set", "token_exists", "token_delete", "device_sign_in", "api_request", "grant_notes_folder",
        "notes_atomic_write", "notes_scan", "notify_test", "window_eval_probe",
    ];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)))
        .expect("tauri build");
}
