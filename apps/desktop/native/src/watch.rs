//! The folder watcher (SYNC-09b): a HINT source, never a source of truth (SYNC_PROTOCOL 11, spike S3).
//!
//! Learned in the spike: reading a changed file emits `Access(Open/Close)` events, which feed back into the
//! reader and hang it, so `Access` is dropped here; Atlas's own temp files (`.atlas-tmp-*`) and every
//! dot-path (`.git`, `.obsidian`, `.atlas-trash`) are ignored; the remaining events are coalesced into one
//! notification per quiet window. A scan on start, on focus and periodically is the safety net for events the
//! OS never delivers (overflow, network drives, cloud placeholders).
use notify::{event::EventKind, Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    path::{Path, PathBuf},
    sync::{mpsc, Arc},
    thread,
    time::Duration,
};

/// Should this path (relative to the root) wake the reconciler?
pub fn is_hint_path(rel: &Path) -> bool {
    let mut any = false;
    for c in rel.components() {
        let s = c.as_os_str().to_string_lossy();
        if s.starts_with('.') || s.starts_with('~') {
            return false;
        }
        any = true;
    }
    if !any {
        return false;
    }
    let name = rel.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // notes, and directories (no extension: a renamed or created folder carries notes with it)
    super::notes::is_note_name(&name) || !name.contains('.')
}

pub fn is_hint_event(kind: &EventKind) -> bool {
    !matches!(kind, EventKind::Access(_) | EventKind::Other)
}

pub struct FolderWatcher {
    _watcher: RecommendedWatcher,
}

impl FolderWatcher {
    /// `on_change` is called at most once per `quiet` window of activity, from a helper thread.
    pub fn start(root: &Path, quiet: Duration, on_change: Arc<dyn Fn() + Send + Sync>) -> notify::Result<FolderWatcher> {
        let root: PathBuf = root.canonicalize().map_err(notify::Error::io)?;
        let (tx, rx) = mpsc::channel::<()>();
        let base = root.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| {
                let Ok(ev) = res else {
                    let _ = tx.send(()); // an error (overflow) means "rescan"
                    return;
                };
                if !is_hint_event(&ev.kind) {
                    return;
                }
                if ev.paths.iter().any(|p| p.strip_prefix(&base).map(is_hint_path).unwrap_or(false)) {
                    let _ = tx.send(());
                }
            },
            Config::default(),
        )?;
        watcher.watch(&root, RecursiveMode::Recursive)?;
        thread::spawn(move || {
            while rx.recv().is_ok() {
                // coalesce: wait until nothing arrived for `quiet`
                while rx.recv_timeout(quiet).is_ok() {}
                on_change();
            }
        });
        Ok(FolderWatcher { _watcher: watcher })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::{Expected, Folder, TMP_MARK};
    use std::{fs, sync::atomic::{AtomicUsize, Ordering}};

    fn counting(root: &Path) -> (FolderWatcher, Arc<AtomicUsize>) {
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = n.clone();
        let w = FolderWatcher::start(root, Duration::from_millis(60), Arc::new(move || void(n2.fetch_add(1, Ordering::SeqCst)))).unwrap();
        thread::sleep(Duration::from_millis(100));
        (w, n)
    }
    fn void<T>(_: T) {}
    fn wait_for(n: &AtomicUsize, at_least: usize) -> bool {
        for _ in 0..60 {
            if n.load(Ordering::SeqCst) >= at_least {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn path_filter() {
        for ok in ["a.md", "dir/a.MD", "dir", "dir/sub"] {
            assert!(is_hint_path(Path::new(ok)), "{ok}");
        }
        for no in [".atlas-tmp-1-0", ".git/HEAD", ".obsidian/x.md", ".atlas-trash/1-0-a.md", "a.txt", "dir/.a.md.swp", "~$a.md", ""] {
            assert!(!is_hint_path(Path::new(no)), "{no}");
        }
        assert!(!is_hint_event(&EventKind::Access(notify::event::AccessKind::Any)));
        assert!(is_hint_event(&EventKind::Create(notify::event::CreateKind::File)));
    }

    #[test]
    fn a_new_and_a_changed_note_are_hints_and_events_coalesce() {
        let d = tempfile::tempdir().unwrap();
        let (_w, n) = counting(d.path());
        fs::write(d.path().join("a.md"), "1").unwrap();
        assert!(wait_for(&n, 1), "create was not noticed");
        let before = n.load(Ordering::SeqCst);
        for i in 0..20 {
            fs::write(d.path().join("a.md"), format!("{i}")).unwrap();
        }
        assert!(wait_for(&n, before + 1), "edit was not noticed");
        thread::sleep(Duration::from_millis(300));
        assert!(n.load(Ordering::SeqCst) - before <= 4, "20 writes must coalesce, got {}", n.load(Ordering::SeqCst) - before);
    }

    #[test]
    fn reading_a_file_and_atlas_temp_files_are_not_hints() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("a.md"), "1").unwrap();
        thread::sleep(Duration::from_millis(100));
        let (_w, n) = counting(d.path());
        for _ in 0..10 {
            let _ = fs::read(d.path().join("a.md")); // Access(Open/Close) events
        }
        fs::write(d.path().join(format!("{TMP_MARK}1-1")), "temp").unwrap();
        fs::remove_file(d.path().join(format!("{TMP_MARK}1-1"))).unwrap();
        fs::create_dir_all(d.path().join(".atlas-trash")).unwrap();
        fs::write(d.path().join(".atlas-trash/x.md"), "t").unwrap();
        fs::write(d.path().join("other.txt"), "t").unwrap();
        thread::sleep(Duration::from_millis(600));
        assert_eq!(n.load(Ordering::SeqCst), 0, "no hint was expected");
    }

    #[test]
    fn our_own_atomic_write_is_one_hint_and_leaves_no_temp_name_behind() {
        let d = tempfile::tempdir().unwrap();
        let folder = Folder::new(d.path()).unwrap();
        let (_w, n) = counting(d.path());
        folder.write("x.md", "hello", &Expected::Absent).unwrap();
        assert!(wait_for(&n, 1), "the rename onto the note is a hint (the hash comparison then finds nothing to do)");
        thread::sleep(Duration::from_millis(300));
        assert!(n.load(Ordering::SeqCst) <= 2);
        assert!(fs::read_dir(d.path()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(TMP_MARK)));
    }
}
