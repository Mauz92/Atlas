//! OS keystore for the device token (SYNC-09c). Linux: Secret Service over D-Bus (KWallet's `ksecretd` or GNOME
//! Keyring); Windows: Credential Manager. There is deliberately NO file fallback: no keystore means no token and
//! the app says so. There is no function that hands the token to the webview; only `http.rs` reads it.
#[cfg(not(target_os = "android"))]
use keyring::Entry;
use std::sync::OnceLock;

/// A platform token store installed by the host at start-up (Android: the Keystore-backed plugin, ADR-0075). Without one the
/// OS keyring is used (Linux, Windows). There is still no file fallback anywhere.
pub trait Backend: Send + Sync {
    fn set(&self, token: &str) -> Result<(), String>;
    fn get(&self) -> Result<Option<String>, String>;
    fn delete(&self) -> Result<(), String>;
}

static BACKEND: OnceLock<Box<dyn Backend>> = OnceLock::new();

/// Install the platform backend once. Returns false when one is already installed.
pub fn install(backend: Box<dyn Backend>) -> bool {
    BACKEND.set(backend).is_ok()
}

pub const DEFAULT_SERVICE: &str = "atlas-desktop";
pub const USER: &str = "device-token";

/// Where the token lives. `ATLAS_KEYSTORE_SERVICE` lets the end-to-end test use a throwaway entry name.
#[cfg(not(target_os = "android"))]
fn service() -> String {
    std::env::var("ATLAS_KEYSTORE_SERVICE").ok().filter(|s| s.starts_with("atlas-")).unwrap_or_else(|| DEFAULT_SERVICE.to_string())
}

#[cfg(not(target_os = "android"))]
fn entry() -> Result<Entry, String> {
    Entry::new(&service(), USER).map_err(|e| describe(&e))
}

/// A stable, content-free description of a failure for the UI ("keystore unavailable").
#[cfg(not(target_os = "android"))]
pub fn describe(e: &keyring::Error) -> String {
    match e {
        keyring::Error::NoEntry => "no_entry".into(),
        keyring::Error::NoStorageAccess(_) => format!("no_storage_access: {e}"),
        keyring::Error::PlatformFailure(_) => format!("platform_failure: {e}"),
        other => format!("other: {other}"),
    }
}

pub fn set(token: &str) -> Result<(), String> {
    if let Some(b) = BACKEND.get() {
        return b.set(token);
    }
    keyring_set(token)
}

#[cfg(target_os = "android")]
fn keyring_set(_: &str) -> Result<(), String> {
    Err("no_keystore_backend".into())
}
#[cfg(not(target_os = "android"))]
fn keyring_set(token: &str) -> Result<(), String> {
    entry()?.set_password(token).map_err(|e| describe(&e))
}

/// Only Rust code in this crate calls this (`http.rs`); it is not a webview command.
pub(crate) fn get() -> Result<Option<String>, String> {
    if let Some(b) = BACKEND.get() {
        return b.get();
    }
    keyring_get()
}

#[cfg(target_os = "android")]
fn keyring_get() -> Result<Option<String>, String> {
    Err("no_keystore_backend".into())
}
#[cfg(not(target_os = "android"))]
fn keyring_get() -> Result<Option<String>, String> {
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
    if let Some(b) = BACKEND.get() {
        return b.delete();
    }
    keyring_delete()
}

#[cfg(target_os = "android")]
fn keyring_delete() -> Result<(), String> {
    Err("no_keystore_backend".into())
}
#[cfg(not(target_os = "android"))]
fn keyring_delete() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(describe(&e)),
    }
}
