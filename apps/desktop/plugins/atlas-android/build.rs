// No command is exposed to the webview: the host (src-tauri) calls the plugin from Rust and decides what the page may do.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
