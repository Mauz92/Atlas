//! OS keystore for the device token (SYNC-09c). Linux: Secret Service over D-Bus (KWallet's `ksecretd` or GNOME
//! Keyring); Windows: Credential Manager. There is deliberately NO file fallback: no keystore means no token and
//! the app says so. There is no function that hands the token to the webview; only `http.rs` reads it.
use keyring::Entry;

pub const DEFAULT_SERVICE: &str = "atlas-desktop";
pub const USER: &str = "device-token";

/// Where the token lives. `ATLAS_KEYSTORE_SERVICE` lets the end-to-end test use a throwaway entry name.
fn service() -> String {
    std::env::var("ATLAS_KEYSTORE_SERVICE").ok().filter(|s| s.starts_with("atlas-")).unwrap_or_else(|| DEFAULT_SERVICE.to_string())
}

fn entry() -> Result<Entry, String> {
    Entry::new(&service(), USER).map_err(|e| describe(&e))
}

/// A stable, content-free description of a failure for the UI ("keystore unavailable").
pub fn describe(e: &keyring::Error) -> String {
    match e {
        keyring::Error::NoEntry => "no_entry".into(),
        keyring::Error::NoStorageAccess(_) => format!("no_storage_access: {e}"),
        keyring::Error::PlatformFailure(_) => format!("platform_failure: {e}"),
        other => format!("other: {other}"),
    }
}

pub fn set(token: &str) -> Result<(), String> {
    entry()?.set_password(token).map_err(|e| describe(&e))
}

/// Only Rust code in this crate calls this (`http.rs`); it is not a webview command.
pub(crate) fn get() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(describe(&e)),
    }
}

pub fn exists() -> Result<bool, String> {
    get().map(|v| v.is_some())
}

pub fn delete() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(describe(&e)),
    }
}
