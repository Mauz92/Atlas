//! OS keystore for the device token (check S4). Linux: Secret Service over D-Bus (KWallet's
//! ksecretd or GNOME Keyring). There is deliberately NO file fallback: no store means no token.
use keyring::Entry;

pub const SERVICE: &str = "atlas-spike-sync07";
pub const USER: &str = "device-token";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, USER).map_err(|e| describe(&e))
}

/// A stable, content-free description of the failure for the UI ("Secret Service unavailable", ...).
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

/// Only Rust code may call this (it is not a webview command).
pub fn get() -> Result<Option<String>, String> {
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
