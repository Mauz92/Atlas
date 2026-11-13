fn main() {
    // Every command needs an explicit permission: the webview can call only what `capabilities/main.json` grants.
    let commands: &[&str] = &[
        "app_info", "db_open", "db_get", "db_list", "db_commit",
        "session_sign_in", "session_info", "session_clear", "session_sign_out", "api_request",
        "folder_root", "folder_choose", "folder_scan", "folder_read", "folder_write", "folder_rename", "folder_trash",
        "notify_permission", "notify_request_permission", "notify_show",
        "tray_set_close_to_tray", "tray_set_status",
        "autostart_is_enabled", "autostart_set_enabled",
        "window_show", "app_quit",
        "update_check",
        "alarm_schedule", "alarm_cancel", "alarm_list", "alarm_delivered", "alarm_clear_shown",
        "android_status", "android_open_settings", "android_take_launch_task", "notes_export", "notes_location_get", "keep_connected_get", "keep_connected_set", "notes_location_set",
        "e2e_report", "e2e_window_state", "e2e_tray", "e2e_close_window", "e2e_exit",
    ];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)))
        .expect("tauri build");
}
