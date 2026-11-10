//! Rust half of the Atlas desktop client (SYNC-09, ADR-0069).
//!
//! Everything here is a small, separately tested primitive. The Tauri shell (`src-tauri`) only turns them
//! into commands; the policy (what to sync, when, how to merge) is TypeScript in `packages/desktop-core`.
pub mod http;
pub mod keystore;
pub mod notes;
pub mod rules;
pub mod store;
pub mod watch;
