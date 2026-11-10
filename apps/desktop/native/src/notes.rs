//! The confined notes folder (SYNC-09b, SYNC_PROTOCOL 11, MARKDOWN_STORAGE).
//!
//! One granted root; every operation takes a RELATIVE, `/`-separated path and resolves it inside the root
//! (no absolute paths, no `..`, no dot-directories, no symlink that leaves the root). Writes are atomic
//! (temp file in the same directory, fsync, rename, directory fsync where the OS allows) and compare-and-swap
//! on the SHA-256 of the bytes, repeated right before the rename. Deletes never happen: files go to
//! `.atlas-trash/`. Hashing is the server's `content_hash` (SHA-256 of the UTF-8 bytes).
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::UNIX_EPOCH,
};

/// Notes above this size are listed as `too_large` and never read (SYNC_PROTOCOL 11).
pub const MAX_NOTE_BYTES: u64 = 5 * 1024 * 1024;
/// Prefix of Atlas's own temp files (a dot name, so every scan and the watcher ignore it).
pub const TMP_MARK: &str = ".atlas-tmp-";
pub const TRASH_DIR: &str = ".atlas-trash";

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// `*.md` (any case), not hidden, not an Office lock file.
pub fn is_note_name(name: &str) -> bool {
    !name.starts_with('.') && !name.starts_with('~') && name.len() > 3 && name[name.len() - 3..].eq_ignore_ascii_case(".md")
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Entry {
    pub path: String,
    pub size: u64,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: f64,
    pub hash: String,
    /// `ok`, `too_large` or `invalid_utf8`
    pub status: &'static str,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Expected {
    /// The file must not exist.
    Absent,
    /// The file must exist with this hash.
    Hash(String),
}

#[derive(Debug, PartialEq, Eq)]
pub enum WriteOutcome {
    Written(String),
    Changed,
    Exists,
}

#[derive(Debug, PartialEq, Eq)]
pub enum MoveOutcome {
    Done,
    Changed,
    Exists,
    Missing,
}

/// size, mtime (ns), hash, status of a scanned file.
type CacheRow = (u64, u128, String, &'static str);

pub struct Folder {
    root: PathBuf,
    /// path -> (size, mtime ns, hash, status): a file whose size and mtime did not change keeps its hash (not on a full scan).
    cache: Mutex<HashMap<String, CacheRow>>,
}

impl Folder {
    /// The root must exist and is canonicalised once; a root that later disappears is `root_missing`.
    pub fn new(root: &Path) -> Result<Folder, String> {
        let root = root.canonicalize().map_err(|e| format!("root_missing: {e}"))?;
        if !root.is_dir() {
            return Err("root_missing: not a directory".into());
        }
        Ok(Folder { root, cache: Mutex::new(HashMap::new()) })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve `rel` inside the root. Refuses absolute paths, `..`, NUL, backslashes, dot-segments (`.git`,
    /// `.atlas-trash`, `.obsidian`) and any path whose existing part resolves (through symlinks) outside the root.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, String> {
        if rel.is_empty() || rel.contains('\0') || rel.contains('\\') {
            return Err("refused: bad path".into());
        }
        if rel.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
            return Err("refused: empty, . or .. segment".into());
        }
        let p = Path::new(rel);
        if p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
            return Err("refused: path must be relative without ..".into());
        }
        if p.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.')) {
            return Err("refused: hidden path".into());
        }
        if !self.root.is_dir() {
            return Err("root_missing".into());
        }
        let joined = self.root.join(p);
        let mut anchor = joined.as_path();
        while fs::symlink_metadata(anchor).is_err() {
            anchor = anchor.parent().ok_or("refused: no ancestor")?;
        }
        let real = anchor.canonicalize().map_err(|e| e.to_string())?;
        if !real.starts_with(&self.root) {
            return Err("refused: path leaves the notes folder".into());
        }
        // a symlink as the final component is refused too (it would be followed on read and replaced on rename)
        if fs::symlink_metadata(&joined).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            return Err("refused: symlink".into());
        }
        Ok(joined)
    }

    fn rel_of(&self, abs: &Path) -> String {
        abs.strip_prefix(&self.root).unwrap().components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
    }

    /// Every note below the root. `full`: hash every file; otherwise unchanged (size, mtime) files keep their cached hash.
    pub fn scan(&self, full: bool) -> Result<Vec<Entry>, String> {
        if !self.root.is_dir() {
            return Err("root_missing".into());
        }
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut cache = self.cache.lock().unwrap();
        self.walk(&self.root, full, &mut cache, &mut out, &mut seen);
        cache.retain(|k, _| seen.contains(k));
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    fn walk(&self, dir: &Path, full: bool, cache: &mut HashMap<String, CacheRow>, out: &mut Vec<Entry>, seen: &mut std::collections::HashSet<String>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(ft) = e.file_type() else { continue };
            let p = e.path();
            if ft.is_dir() {
                if !name.starts_with('.') {
                    self.walk(&p, full, cache, out, seen);
                }
            } else if ft.is_file() && is_note_name(&name) {
                let Ok(m) = e.metadata() else { continue };
                let ns = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
                let rel = self.rel_of(&p);
                seen.insert(rel.clone());
                let (hash, status) = match cache.get(&rel) {
                    Some((size, mt, h, st)) if !full && *size == m.len() && *mt == ns => (h.clone(), *st),
                    _ => {
                        let computed = if m.len() > MAX_NOTE_BYTES {
                            (String::new(), "too_large")
                        } else {
                            match fs::read(&p) {
                                Ok(bytes) => (sha256_hex(&bytes), if std::str::from_utf8(&bytes).is_ok() { "ok" } else { "invalid_utf8" }),
                                Err(_) => continue,
                            }
                        };
                        cache.insert(rel.clone(), (m.len(), ns, computed.0.clone(), computed.1));
                        computed
                    }
                };
                out.push(Entry { path: rel, size: m.len(), mtime_ms: ns as f64 / 1e6, hash, status });
            }
        }
    }

    /// UTF-8 text of a note (refuses over-size and invalid UTF-8).
    pub fn read(&self, rel: &str) -> Result<String, String> {
        let p = self.resolve(rel)?;
        let m = fs::metadata(&p).map_err(|e| e.to_string())?;
        if m.len() > MAX_NOTE_BYTES {
            return Err("too_large".into());
        }
        String::from_utf8(fs::read(&p).map_err(|e| e.to_string())?).map_err(|_| "invalid_utf8".to_string())
    }

    fn current_hash(path: &Path) -> Option<String> {
        fs::read(path).ok().map(|b| sha256_hex(&b))
    }

    fn matches(path: &Path, expected: &Expected) -> Option<WriteOutcome> {
        match expected {
            Expected::Absent => path.exists().then_some(WriteOutcome::Exists),
            Expected::Hash(h) => (Self::current_hash(path).as_deref() != Some(h.as_str())).then_some(WriteOutcome::Changed),
        }
    }

    /// Atomic compare-and-swap write. The expectation is checked before the temp file is written AND again
    /// immediately before the rename (the remaining window is the rename itself).
    pub fn write(&self, rel: &str, content: &str, expected: &Expected) -> Result<WriteOutcome, String> {
        let target = self.resolve(rel)?;
        if let Some(out) = Self::matches(&target, expected) {
            return Ok(out);
        }
        if content.len() as u64 > MAX_NOTE_BYTES {
            return Err("too_large".into());
        }
        let dir = target.parent().ok_or("no parent")?;
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        // create_dir_all may have followed a symlink that appeared meanwhile: resolve again from the real directory
        self.resolve(rel)?;
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let tmp = dir.join(format!("{TMP_MARK}{}-{n}", std::process::id()));
        let result = (|| -> std::io::Result<WriteOutcome> {
            let mut f = File::create(&tmp)?;
            f.write_all(content.as_bytes())?;
            f.sync_all()?;
            if let Some(out) = Self::matches(&target, expected) {
                return Ok(out);
            }
            fs::rename(&tmp, &target)?;
            sync_dir(dir);
            Ok(WriteOutcome::Written(sha256_hex(content.as_bytes())))
        })();
        let _ = fs::remove_file(&tmp); // gone after a successful rename; removes the temp of a refused write
        result.map_err(|e| e.to_string())
    }

    pub fn rename(&self, from: &str, to: &str, expected_hash: &str) -> Result<MoveOutcome, String> {
        let src = self.resolve(from)?;
        let dst = self.resolve(to)?;
        if !src.is_file() {
            return Ok(MoveOutcome::Missing);
        }
        if Self::current_hash(&src).as_deref() != Some(expected_hash) {
            return Ok(MoveOutcome::Changed);
        }
        if dst.exists() {
            return Ok(MoveOutcome::Exists);
        }
        let dir = dst.parent().ok_or("no parent")?;
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        self.resolve(to)?;
        fs::rename(&src, &dst).map_err(|e| e.to_string())?;
        sync_dir(dir);
        Ok(MoveOutcome::Done)
    }

    /// Move a note to `.atlas-trash/<ms>-<n>-<name>` (never deletes). `Changed` when it was edited meanwhile.
    pub fn trash(&self, rel: &str, expected_hash: &str) -> Result<MoveOutcome, String> {
        let src = self.resolve(rel)?;
        if !src.is_file() {
            return Ok(MoveOutcome::Missing);
        }
        if Self::current_hash(&src).as_deref() != Some(expected_hash) {
            return Ok(MoveOutcome::Changed);
        }
        let trash = self.root.join(TRASH_DIR);
        fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
        let ms = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let flat = rel.replace('/', "__");
        fs::rename(&src, trash.join(format!("{ms}-{n}-{flat}"))).map_err(|e| e.to_string())?;
        Ok(MoveOutcome::Done)
    }
}

/// POSIX: fsync the directory so the rename itself is durable. Windows cannot open a directory with `File::open`
/// (os error 5, "Access is denied": found on the first Windows runner in SYNC-07, AFTER the rename had succeeded, so a
/// good write reported failure), and `std`'s rename there is MoveFileExW with MOVEFILE_REPLACE_EXISTING with no
/// directory flush available: there, durability of the rename after a power cut is whatever NTFS journals.
/// A failure of the directory fsync never fails a write that already happened.
#[allow(unused_variables)]
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder() -> (tempfile::TempDir, Folder) {
        let d = tempfile::tempdir().unwrap();
        let f = Folder::new(d.path()).unwrap();
        (d, f)
    }

    fn h(s: &str) -> String {
        sha256_hex(s.as_bytes())
    }

    #[test]
    fn hash_is_the_servers_content_hash() {
        assert_eq!(h("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn resolve_refuses_everything_outside_the_root() {
        let (d, f) = folder();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "s").unwrap();
        std::os::unix::fs::symlink(outside.path(), d.path().join("link")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.md"), d.path().join("file.md")).unwrap();
        for bad in ["/etc/hostname", "../x.md", "a/../../x.md", "a/./b.md", ".hidden.md", ".git/config", ".atlas-trash/x.md", "", "a\\b.md", "link/secret.md", "link/new.md", "file.md"] {
            assert!(f.resolve(bad).is_err(), "{bad:?} must be refused");
        }
        assert!(f.resolve("sub/dir/ok.md").is_ok());
        // a sibling folder that shares the prefix is not inside the root
        let sib = PathBuf::from(format!("{}-sibling", d.path().display()));
        fs::create_dir_all(&sib).unwrap();
        std::os::unix::fs::symlink(&sib, d.path().join("sib")).unwrap();
        assert!(f.resolve("sib/x.md").is_err());
        fs::remove_dir_all(sib).unwrap();
    }

    #[test]
    fn write_is_compare_and_swap() {
        let (_d, f) = folder();
        assert_eq!(f.write("a/b.md", "one", &Expected::Absent).unwrap(), WriteOutcome::Written(h("one")));
        assert_eq!(f.write("a/b.md", "x", &Expected::Absent).unwrap(), WriteOutcome::Exists);
        assert_eq!(f.write("a/b.md", "two", &Expected::Hash(h("nope"))).unwrap(), WriteOutcome::Changed);
        assert_eq!(f.read("a/b.md").unwrap(), "one");
        assert_eq!(f.write("a/b.md", "two", &Expected::Hash(h("one"))).unwrap(), WriteOutcome::Written(h("two")));
        assert_eq!(f.read("a/b.md").unwrap(), "two");
        // no temp file is left behind, also after a refused write
        let names: Vec<_> = fs::read_dir(f.root().join("a")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["b.md"]);
    }

    #[test]
    fn scan_lists_only_notes_and_flags_bad_files() {
        let (d, f) = folder();
        f.write("n/one.md", "héllo", &Expected::Absent).unwrap();
        fs::write(d.path().join("two.MD"), "x").unwrap();
        fs::write(d.path().join("not-a-note.txt"), "x").unwrap();
        fs::write(d.path().join(".hidden.md"), "x").unwrap();
        fs::write(d.path().join("~$lock.md"), "x").unwrap();
        fs::write(d.path().join("bad.md"), [0xff, 0xfe, 0x00]).unwrap();
        fs::create_dir_all(d.path().join(".obsidian")).unwrap();
        fs::write(d.path().join(".obsidian/x.md"), "x").unwrap();
        let huge = fs::File::create(d.path().join("huge.md")).unwrap();
        huge.set_len(MAX_NOTE_BYTES + 1).unwrap();
        let entries = f.scan(true).unwrap();
        let view: Vec<_> = entries.iter().map(|e| (e.path.as_str(), e.status)).collect();
        assert_eq!(view, vec![("bad.md", "invalid_utf8"), ("huge.md", "too_large"), ("n/one.md", "ok"), ("two.MD", "ok")]);
        assert_eq!(entries[2].hash, h("héllo"));
        assert_eq!(entries[1].hash, "");
    }

    #[test]
    fn a_same_size_same_mtime_edit_is_only_seen_by_a_full_scan() {
        let (d, f) = folder();
        let p = d.path().join("s.md");
        fs::write(&p, "aaaa").unwrap();
        let before = fs::metadata(&p).unwrap().modified().unwrap();
        assert_eq!(f.scan(true).unwrap()[0].hash, h("aaaa"));
        fs::write(&p, "bbbb").unwrap();
        File::options().write(true).open(&p).unwrap().set_modified(before).unwrap();
        // the cheap scan trusts (size, mtime): the documented limit
        assert_eq!(f.scan(false).unwrap()[0].hash, h("aaaa"));
        // the full scan (start, focus, periodic) hashes everything and finds it
        assert_eq!(f.scan(true).unwrap()[0].hash, h("bbbb"));
    }

    #[test]
    fn a_missing_root_is_an_error_never_an_empty_list() {
        let (d, f) = folder();
        let path = d.path().to_path_buf();
        drop(d);
        assert!(!path.exists());
        assert_eq!(f.scan(true).unwrap_err(), "root_missing");
    }

    #[test]
    fn rename_and_trash_check_the_hash_and_never_delete() {
        let (_d, f) = folder();
        f.write("old.md", "text", &Expected::Absent).unwrap();
        assert_eq!(f.rename("old.md", "new/name.md", &h("other")).unwrap(), MoveOutcome::Changed);
        assert_eq!(f.rename("old.md", "new/name.md", &h("text")).unwrap(), MoveOutcome::Done);
        f.write("taken.md", "t", &Expected::Absent).unwrap();
        assert_eq!(f.rename("new/name.md", "taken.md", &h("text")).unwrap(), MoveOutcome::Exists);
        assert_eq!(f.trash("new/name.md", &h("edited")).unwrap(), MoveOutcome::Changed);
        assert_eq!(f.trash("new/name.md", &h("text")).unwrap(), MoveOutcome::Done);
        assert_eq!(f.trash("new/name.md", &h("text")).unwrap(), MoveOutcome::Missing);
        let kept: Vec<_> = fs::read_dir(f.root().join(TRASH_DIR)).unwrap().map(|e| fs::read_to_string(e.unwrap().path()).unwrap()).collect();
        assert_eq!(kept, vec!["text"]);
        assert!(f.scan(true).unwrap().iter().all(|e| !e.path.starts_with(TRASH_DIR)), "the trash is not scanned");
    }
}
