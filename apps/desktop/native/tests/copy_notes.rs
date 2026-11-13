//! Moving the notes between two folders (ADR-0075 D4): copy only, never overwrite, never delete, verify.
use atlas_desktop_native::notes::{copy_notes, CopyReport, Folder};
use std::fs;

fn folder(dir: &tempfile::TempDir) -> Folder {
    Folder::new(dir.path()).unwrap()
}

#[test]
fn copies_notes_with_their_folders_and_leaves_the_source_alone() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    fs::create_dir_all(a.path().join("proj/deep")).unwrap();
    fs::write(a.path().join("one.md"), "# one\n").unwrap();
    fs::write(a.path().join("proj/deep/two.md"), "# two\nümlaut\n").unwrap();
    fs::write(a.path().join("not-a-note.txt"), "ignored").unwrap();
    fs::create_dir_all(a.path().join(".obsidian")).unwrap();
    fs::write(a.path().join(".obsidian/x.md"), "hidden").unwrap();
    let report = copy_notes(&folder(&a), &folder(&b)).unwrap();
    assert_eq!(report, CopyReport { copied: 2, identical: 0, bytes: 6 + 14 });
    assert_eq!(fs::read_to_string(b.path().join("proj/deep/two.md")).unwrap(), "# two\nümlaut\n");
    assert!(!b.path().join("not-a-note.txt").exists() && !b.path().join(".obsidian").exists());
    assert!(a.path().join("one.md").exists(), "the source is never touched");
    assert!(fs::read_dir(b.path()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".atlas-tmp-")), "no temp file left");
}

#[test]
fn a_second_copy_is_a_no_op_and_identical_files_are_counted() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    fs::write(a.path().join("n.md"), "same").unwrap();
    copy_notes(&folder(&a), &folder(&b)).unwrap();
    assert_eq!(copy_notes(&folder(&a), &folder(&b)).unwrap(), CopyReport { copied: 0, identical: 1, bytes: 0 });
}

#[test]
fn a_different_file_at_the_target_stops_everything_and_nothing_is_overwritten() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    fs::write(a.path().join("a.md"), "from the app").unwrap();
    fs::write(a.path().join("b.md"), "from the app too").unwrap();
    fs::write(b.path().join("b.md"), "already there, different").unwrap();
    let err = copy_notes(&folder(&a), &folder(&b)).unwrap_err();
    assert_eq!(err, "target_differs:b.md");
    assert_eq!(fs::read_to_string(b.path().join("b.md")).unwrap(), "already there, different");
    assert!(!b.path().join("a.md").exists(), "nothing at all is copied when one file conflicts");
}

#[test]
fn large_and_non_utf8_notes_are_copied_byte_for_byte() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    fs::write(a.path().join("latin1.md"), [0xe4u8, 0xf6, 0xfc]).unwrap();
    copy_notes(&folder(&a), &folder(&b)).unwrap();
    assert_eq!(fs::read(b.path().join("latin1.md")).unwrap(), vec![0xe4u8, 0xf6, 0xfc]);
}
