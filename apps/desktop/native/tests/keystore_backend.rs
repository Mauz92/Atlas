//! The platform backend hook of the keystore (Android: the Keystore-backed plugin, ADR-0075). A separate test binary, because the
//! backend is installed once per process.
use atlas_desktop_native::keystore::{self, Backend};
use std::sync::Mutex;

#[derive(Default)]
struct Fake {
    token: Mutex<Option<String>>,
    fail: Mutex<bool>,
}

struct Handle(std::sync::Arc<Fake>);

impl Backend for Handle {
    fn set(&self, token: &str) -> Result<(), String> {
        if *self.0.fail.lock().unwrap() {
            return Err("keystore_failed".into());
        }
        *self.0.token.lock().unwrap() = Some(token.to_string());
        Ok(())
    }
    fn get(&self) -> Result<Option<String>, String> {
        Ok(self.0.token.lock().unwrap().clone())
    }
    fn delete(&self) -> Result<(), String> {
        *self.0.token.lock().unwrap() = None;
        Ok(())
    }
}

#[test]
fn an_installed_backend_is_the_only_store_and_a_second_install_is_refused() {
    let fake = std::sync::Arc::new(Fake::default());
    assert!(keystore::install(Box::new(Handle(fake.clone()))));
    assert!(!keystore::install(Box::new(Handle(fake.clone()))), "one backend per process");

    assert_eq!(keystore::exists(), Ok(false));
    keystore::set("atd_not_a_real_token").unwrap();
    assert_eq!(fake.token.lock().unwrap().as_deref(), Some("atd_not_a_real_token"));
    assert_eq!(keystore::exists(), Ok(true));
    keystore::delete().unwrap();
    assert_eq!(keystore::exists(), Ok(false));

    // a backend failure is reported, never swallowed and never turned into a file or the OS keyring
    *fake.fail.lock().unwrap() = true;
    assert_eq!(keystore::set("x"), Err("keystore_failed".into()));
    assert_eq!(keystore::exists(), Ok(false));
}
