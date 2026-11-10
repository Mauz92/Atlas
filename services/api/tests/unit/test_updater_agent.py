"""The host updater (deploy/updater/atlas_updater.py): rules and the update/rollback sequence.

Docker is faked. The tests pin the rules that protect the owner's data: no downgrade, no unsafe
bundle paths, the application is stopped before the backup, a failed start restores the previous
version and (only when the database was migrated) the backup.
"""

from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "atlas_updater", Path(__file__).resolve().parents[4] / "deploy/updater/atlas_updater.py"
)
assert SPEC and SPEC.loader
au = importlib.util.module_from_spec(SPEC)
sys.modules["atlas_updater"] = au
SPEC.loader.exec_module(au)


def bundle(files: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


BACKUP_DIR = "/data/atlas/backups/atlas-backup-20261110-abc"
GOOD = {
    "deploy/docker-compose.yml": "services: {}\n",
    "deploy/docker-compose.release.yml": "services: {}\n",
}


class FakeGitHub:
    def __init__(self, latest: str = "0.2.0", files: dict[str, str] | None = None) -> None:
        self.latest, self.files = latest, GOOD if files is None else files

    def newest(self) -> tuple[str, str]:
        return self.latest, "notes"

    def asset(self, version: str, name: str) -> bytes:
        return bundle(self.files)


class FakeDocker:
    """Records commands; ``fail_health`` makes the new version never become healthy."""

    def __init__(self, config, *, fail_health: bool = False, revisions=("rev1", "rev2")) -> None:
        self.config = config
        self.calls: list[str] = []
        self.fail_health = fail_health
        self.revisions = list(revisions)
        self.run = self._run

    def _run(self, argv, **kwargs):
        self.calls.append("run:" + " ".join(argv[:3]))
        return subprocess.CompletedProcess(argv, 0, "", "")

    def login(self) -> None:
        self.calls.append("login")

    def pull(self, version: str) -> None:
        self.calls.append(f"pull {version}")

    def revision(self) -> str:
        return self.revisions.pop(0) if self.revisions else "rev2"

    def compose(self, *args, release=True, check=True, **kwargs):
        self.calls.append(("compose " + " ".join(args))[:80])
        if args[:2] == ("run", "--rm") and "atlas-backup" in args and "run" in args[-1:]:
            return subprocess.CompletedProcess(
                args, 0, f"backup ok: x\n  directory: {BACKUP_DIR}\n", ""
            )
        return subprocess.CompletedProcess(args, 0, "", "")

    def _compose(self, release):
        return ["docker", "compose"]

    def wait_healthy(self, version: str, timeout: int) -> None:
        self.calls.append(f"health {version}")
        if self.fail_health and version == "0.2.0":
            raise au.UpdateError("never healthy")


@pytest.fixture
def config(tmp_path: Path):
    install = tmp_path / "atlas"
    (install / "deploy").mkdir(parents=True)
    (install / "deploy/docker-compose.yml").write_text("old\n")
    (install / "update").mkdir()
    return au.Config(install_dir=install)


def make(config, *, github=None, docker=None, free=lambda _p: 10**11):
    return au.Updater(
        config, github=github or FakeGitHub(), docker=docker or FakeDocker(config), free=free
    )


def status(config) -> dict:
    return json.loads(config.status_path.read_text())


def test_versions_compare_numerically_and_reject_junk() -> None:
    assert au.newer("0.10.0", "0.9.9") and not au.newer("0.2.0", "0.2.0")
    for bad in ("", "latest", "1.2", "1.2.3.4", "../1.2.3", "1.2.3-rc1", None, 5):
        assert not au.is_version(bad)
    assert au.parse_version("v1.2.3") == (1, 2, 3)


def test_check_reports_an_available_update(config) -> None:
    make(config).check()
    data = status(config)
    assert (data["latest"], data["update_available"], data["current"]) == ("0.2.0", True, "0.0.0")


def test_a_successful_update_stops_before_the_backup_and_records_the_new_version(config) -> None:
    docker = FakeDocker(config)
    make(config, docker=docker).apply("0.2.0")
    calls = docker.calls
    stop = next(i for i, c in enumerate(calls) if c.startswith("compose stop web api worker"))
    backup = next(i for i, c in enumerate(calls) if "atlas-backup run" in c)
    start = "compose up -d --no-build --remove-orphans"
    up = max(i for i, c in enumerate(calls) if c.startswith(start))
    # pull first, then stop, then back up, then start
    assert calls.index("pull 0.2.0") < stop < backup < up
    assert (config.update_dir / "version.env").read_text() == "ATLAS_VERSION=0.2.0\n"
    assert (config.install_dir / "deploy/docker-compose.release.yml").is_file()
    assert (config.update_dir / "previous-deploy/deploy/docker-compose.yml").read_text() == "old\n"
    assert status(config)["state"] == "idle" and status(config)["current"] == "0.2.0"


def test_a_downgrade_or_the_same_version_is_refused_before_anything_changes(config) -> None:
    (config.update_dir / "version.env").write_text("ATLAS_VERSION=0.3.0\n")
    docker = FakeDocker(config)
    with pytest.raises(au.UpdateError, match="downgrade"):
        make(config, docker=docker).apply("0.2.0")
    assert docker.calls == []


def test_low_disk_space_stops_before_anything_changes(config) -> None:
    docker = FakeDocker(config)
    with pytest.raises(au.UpdateError, match="disk space"):
        make(config, docker=docker, free=lambda _p: 1000).apply("0.2.0")
    assert docker.calls == []


def test_a_new_version_that_never_becomes_healthy_is_rolled_back_with_the_database_restored(
    config,
) -> None:
    (config.update_dir / "version.env").write_text("ATLAS_VERSION=0.1.0\n")
    docker = FakeDocker(config, fail_health=True, revisions=("rev1", "rev2"))
    restored: list[str] = []
    updater = make(config, docker=docker)
    updater._restore_database = restored.append  # type: ignore[method-assign]
    with pytest.raises(au.UpdateError):
        updater.apply("0.2.0")
    assert restored == [f"{BACKUP_DIR}/database.sql"]
    assert (config.update_dir / "version.env").read_text() == "ATLAS_VERSION=0.1.0\n"
    assert (config.install_dir / "deploy/docker-compose.yml").read_text() == "old\n"
    assert "health 0.1.0" in docker.calls
    assert docker.calls[-1].endswith("record-restore")
    assert status(config)["state"] == "rolled_back"


def test_rollback_keeps_the_database_when_the_new_version_did_not_migrate(config) -> None:
    (config.update_dir / "version.env").write_text("ATLAS_VERSION=0.1.0\n")
    docker = FakeDocker(config, fail_health=True, revisions=("rev1", "rev1"))
    restored: list[str] = []
    updater = make(config, docker=docker)
    updater._restore_database = restored.append  # type: ignore[method-assign]
    with pytest.raises(au.UpdateError):
        updater.apply("0.2.0")
    assert restored == []


def test_a_failed_pull_changes_nothing(config) -> None:
    docker = FakeDocker(config)

    def boom(_version: str) -> None:
        raise au.UpdateError("no such image")

    docker.pull = boom  # type: ignore[method-assign]
    with pytest.raises(au.UpdateError):
        make(config, docker=docker).apply("0.2.0")
    assert not any(c.startswith("compose stop") for c in docker.calls)
    assert not (config.update_dir / "version.env").exists()


def test_a_bundle_cannot_write_outside_the_allowed_paths(config) -> None:
    evil = {**GOOD, "../escape.txt": "x"}
    with pytest.raises(au.UpdateError, match="unsafe"):
        make(config, github=FakeGitHub(files=evil)).apply("0.2.0")
    assert not (config.install_dir.parent / "escape.txt").exists()


def test_a_bundle_without_the_release_compose_file_is_refused(config) -> None:
    with pytest.raises(au.UpdateError, match="lacks"):
        make(config, github=FakeGitHub(files={"deploy/docker-compose.yml": "x"})).apply("0.2.0")


def test_a_request_for_a_version_that_is_not_the_newest_is_refused(config) -> None:
    config.request_path.write_text(json.dumps({"action": "apply", "version": "0.1.5"}))
    docker = FakeDocker(config)
    with pytest.raises(au.UpdateError, match="not the newest"):
        make(config, docker=docker).handle_request()
    assert docker.calls == []
    assert not config.request_path.exists()  # consumed first: a crash cannot loop


def test_a_garbled_request_is_dropped(config) -> None:
    config.request_path.write_text("nope")
    make(config).handle_request()
    assert not config.request_path.exists()


def test_pruning_removes_only_images_older_than_the_two_that_matter(config) -> None:
    removed: list[str] = []

    def run(argv, **kwargs):
        if argv[:3] == ["docker", "image", "ls"]:
            tags = ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]
            out = (
                "\n".join(f"ghcr.io/mauz92/atlas-api:{t}" for t in tags) + "\npostgres:17-alpine\n"
            )
            return subprocess.CompletedProcess(argv, 0, out, "")
        if argv[:3] == ["docker", "image", "rm"]:
            removed.append(argv[3])
        return subprocess.CompletedProcess(argv, 0, "", "")

    docker = FakeDocker(config)
    docker.run = run
    make(config, docker=docker)._prune({"0.2.0", "0.3.0"})
    assert removed == [
        "ghcr.io/mauz92/atlas-api:0.1.0"
    ]  # 0.4.0 (not installed yet) and postgres stay
