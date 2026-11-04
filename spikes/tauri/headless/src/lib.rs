//! Shared spike logic (SQLite, notes folder, keystore). Used by the Tauri app and the headless checks.
pub use rusqlite;
pub mod db;
pub mod keystore;
pub mod notes;
