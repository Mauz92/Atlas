//! Notes-folder primitives (check S3): confined path resolution, atomic write, scan.
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static COUNTER: AtomicU64 = AtomicU64::new(0);
pub const TMP_MARK: &str = ".atlas-tmp-";

/// Resolve `rel` inside `root`. Refuses absolute paths, `..`, NUL and symlinks that leave the root.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.contains('\0') {
        return Err("refused: NUL in path".into());
    }
    let p = Path::new(rel);
    if p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("refused: path must be relative without ..".into());
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let joined = root.join(p);
    // Canonicalise the longest existing ancestor so a symlinked directory cannot escape.
    let mut anchor = joined.as_path();
    while !anchor.exists() {
        anchor = anchor.parent().ok_or("refused: no ancestor")?;
    }
    let real = anchor.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(&root) {
        return Err("refused: path leaves the notes folder".into());
    }
    Ok(joined)
}

/// temp file in the same directory + fsync + rename + fsync of the directory.
pub fn atomic_write(root: &Path, rel: &str, content: &[u8]) -> Result<(), String> {
    let target = resolve(root, rel)?;
    let dir = target.parent().ok_or("no parent")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!("{TMP_MARK}{}-{n}", std::process::id()));
    let r = (|| -> std::io::Result<()> {
        let mut f = File::create(&tmp)?;
        f.write_all(content)?;
        f.sync_all()?;
        fs::rename(&tmp, &target)?;
        // POSIX: fsync the directory so the rename itself is durable. Windows cannot open a directory with
        // File::open (os error 5, "Access is denied": found on the first Windows runner, after the rename had
        // already succeeded, which made a good write report failure); std's rename there is MoveFileExW with
        // MOVEFILE_REPLACE_EXISTING and no directory flush is available through std.
        #[cfg(unix)]
        File::open(dir)?.sync_all()?;
        Ok(())
    })();
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    r.map_err(|e| e.to_string())
}

pub fn is_note(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    name.ends_with(".md") && !name.starts_with('.')
}

/// (size, mtime in ns) of every `.md` file below `root`, keyed by relative path.
pub fn scan(root: &Path) -> BTreeMap<String, (u64, u128)> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, (u64, u128)>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if !e.file_name().to_string_lossy().starts_with('.') {
                    walk(base, &p, out);
                }
            } else if ft.is_file() && is_note(&p) {
                if let Ok(m) = e.metadata() {
                    let ns = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
                    out.insert(p.strip_prefix(base).unwrap().to_string_lossy().into_owned(), (m.len(), ns));
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

pub struct Diff {
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
}

pub fn diff(old: &BTreeMap<String, (u64, u128)>, new: &BTreeMap<String, (u64, u128)>) -> Diff {
    let added = new.keys().filter(|k| !old.contains_key(*k)).cloned().collect();
    let removed = old.keys().filter(|k| !new.contains_key(*k)).cloned().collect();
    let modified = new.iter().filter(|(k, v)| old.get(*k).is_some_and(|o| o != *v)).map(|(k, _)| k.clone()).collect();
    Diff { added, modified, removed }
}
