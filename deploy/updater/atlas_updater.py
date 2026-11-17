#!/usr/bin/env python3
"""Atlas host updater (REL-01, ADR-0074).

Runs on the server host, never inside a container, with the rights of the user that runs Docker. The web app
cannot update itself and has no access to Docker: it only drops a small request file into the shared update
directory (``<install>/update``), and a systemd path unit starts this program, which decides for itself whether
the request is acceptable.

    atlas_updater.py check      look for a newer release and write update/status.json
    atlas_updater.py request    handle update/request.json (what systemd runs)
    atlas_updater.py apply [V]  update to V (default: the newest release)

An update never loses data: it pulls the new images *before* anything is stopped, stops the application,
takes a verified backup of the database and the notes, switches the files and images, starts the new version
and waits until it reports itself healthy. If it does not, the previous version is started again and, when the
new version had already migrated the database, the backup taken a minute earlier is restored (nothing could
have been written in between: the application was stopped). Downgrades are refused (migrations only go
forward). Standard library only.
"""

from __future__ import annotations

import fcntl
import io
import json
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

VERSION_RE = re.compile(r"^(\d{1,4})\.(\d{1,5})\.(\d{1,5})$")
SOURCE_BUILD = "0.0.0"  # an install that was built from source has no version.env
STATUS_SCHEMA = 1
NOTES_LIMIT = 4000
LOG_LINES = 40
HEALTH_TIMEOUT_SECONDS = 240
MIN_FREE_BYTES = 1_500_000_000
GITHUB_API = "https://api.github.com"
DEPLOY_ASSET = "atlas-deploy.tar.gz"
CHECKSUMS_ASSET = "SHA256SUMS"
# Only these paths are taken from a release's deploy bundle, so a bundle can never write elsewhere.
DEPLOY_ALLOWED = ("deploy/", "apps/web/nginx.conf", "apps/web/nginx.tls.conf")


class UpdateError(RuntimeError):
    """An update step failed in a way that is explained to the owner as it is worded."""


def parse_version(text: str) -> tuple[int, int, int]:
    match = VERSION_RE.match(text.strip().removeprefix("v"))
    if not match:
        raise ValueError(f"not a version: {text!r}")
    major, minor, patch = (int(g) for g in match.groups())
    return major, minor, patch


def is_version(text: object) -> bool:
    if not isinstance(text, str):
        return False
    try:
        parse_version(text)
    except ValueError:
        return False
    return True


def newer(candidate: str, current: str) -> bool:
    return parse_version(candidate) > parse_version(current)


@dataclass
class Config:
    install_dir: Path
    repo: str = "Mauz92/atlas"
    registry: str = "ghcr.io/mauz92"
    token: str = ""
    github_user: str = ""
    web_port: str = "8080"
    project: str = "atlas"
    api_base: str = GITHUB_API
    health_timeout: int = HEALTH_TIMEOUT_SECONDS
    allow_prerelease: bool = False
    extra: dict[str, str] = field(default_factory=dict)

    @property
    def update_dir(self) -> Path:
        return self.install_dir / "update"

    @property
    def status_path(self) -> Path:
        return self.update_dir / "status.json"

    @property
    def request_path(self) -> Path:
        return self.update_dir / "request.json"

    @property
    def version_env(self) -> Path:
        return self.update_dir / "version.env"


def load_config(install_dir: Path, env_file: Path | None) -> Config:
    """Settings come from the install's .env (WEB_PORT) and the owner-only ``~/.config/atlas-updater/env``."""
    values: dict[str, str] = {}
    for source in (install_dir / ".env", env_file):
        if source is not None and source.is_file():
            for raw in source.read_text().splitlines():
                line = raw.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    values[key.strip()] = value.strip().strip("'\"")
    return Config(
        install_dir=install_dir,
        repo=values.get("ATLAS_UPDATE_REPO", "Mauz92/atlas"),
        registry=values.get("ATLAS_IMAGE_REGISTRY", "ghcr.io/mauz92"),
        token=values.get("ATLAS_UPDATE_TOKEN", ""),
        github_user=values.get("ATLAS_UPDATE_USER", "Mauz92"),
        web_port=values.get("WEB_PORT", "8080"),
        project=values.get("ATLAS_COMPOSE_PROJECT", "atlas"),
        allow_prerelease=values.get("ATLAS_UPDATE_PRERELEASE", "false").lower() == "true",
        extra=values,
    )


# --------------------------------------------------------------------------- status file


class Status:
    """update/status.json: written atomically, read by the API; holds no secret and no path outside the install."""

    def __init__(self, config: Config, *, clock: Callable[[], datetime] | None = None) -> None:
        self.config = config
        self._clock = clock or (lambda: datetime.now(UTC))
        self.data: dict[str, object] = {
            "schema": STATUS_SCHEMA,
            "state": "idle",
            "phase": None,
            "current": SOURCE_BUILD,
            "latest": None,
            "update_available": False,
            "notes": "",
            "checked_at": None,
            "started_at": None,
            "finished_at": None,
            "message": "",
            "log": [],
        }
        try:
            previous = json.loads(config.status_path.read_text())
            if isinstance(previous, dict):
                for key in ("current", "latest", "update_available", "notes", "checked_at", "message"):
                    if key in previous:
                        self.data[key] = previous[key]
        except (OSError, ValueError):
            pass

    def now(self) -> str:
        return self._clock().isoformat(timespec="seconds")

    def log(self, line: str) -> None:
        log = self.data["log"]
        assert isinstance(log, list)
        log.append(f"{self.now()} {line}")
        del log[:-LOG_LINES]
        self.write()

    def set(self, **fields: object) -> None:
        self.data.update(fields)
        self.write()

    def write(self) -> None:
        self.config.update_dir.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.config.update_dir, prefix=".status-")
        with os.fdopen(fd, "w") as handle:
            json.dump(self.data, handle, indent=2)
        os.chmod(tmp, 0o644)  # the API runs as another user and must read it
        os.replace(tmp, self.config.status_path)


# --------------------------------------------------------------------------- GitHub


class GitHub:
    def __init__(self, config: Config) -> None:
        self.config = config

    def _request(self, url: str, accept: str = "application/vnd.github+json") -> urllib.request.Request:
        request = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "atlas-updater"})
        if self.config.token:
            request.add_header("Authorization", f"Bearer {self.config.token}")
        return request

    def json(self, path: str) -> object:
        url = f"{self.config.api_base}/repos/{self.config.repo}{path}"
        try:
            with urllib.request.urlopen(self._request(url), timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as err:
            if err.code in (401, 403):
                raise UpdateError(
                    "GitHub refused the update token. Check ATLAS_UPDATE_TOKEN in ~/.config/atlas-updater/env."
                ) from err
            if err.code == 404:
                raise UpdateError("The release was not found (or the token cannot see the repository).") from err
            raise UpdateError(f"GitHub answered {err.code}.") from err
        except (urllib.error.URLError, TimeoutError) as err:
            raise UpdateError("Could not reach GitHub.") from err

    def releases(self) -> list[dict[str, object]]:
        data = self.json("/releases?per_page=30")
        if not isinstance(data, list):
            raise UpdateError("Unexpected answer from GitHub.")
        return [r for r in data if isinstance(r, dict)]

    def newest(self) -> tuple[str, str] | None:
        """(version, notes) of the newest published, non-draft release with a valid ``vX.Y.Z`` tag."""
        best: tuple[tuple[int, int, int], str, str] | None = None
        for release in self.releases():
            tag = release.get("tag_name")
            if release.get("draft") or (release.get("prerelease") and not self.config.allow_prerelease):
                continue
            if not isinstance(tag, str) or not tag.startswith("v") or not is_version(tag):
                continue
            key = parse_version(tag)
            if best is None or key > best[0]:
                body = release.get("body")
                best = (key, tag.removeprefix("v"), body if isinstance(body, str) else "")
        return (best[1], best[2]) if best else None

    def asset(self, version: str, name: str) -> bytes:
        release = self.json(f"/releases/tags/v{version}")
        assets = release.get("assets", []) if isinstance(release, dict) else []
        for asset in assets:
            if isinstance(asset, dict) and asset.get("name") == name and isinstance(asset.get("id"), int):
                url = f"{self.config.api_base}/repos/{self.config.repo}/releases/assets/{asset['id']}"
                try:
                    with urllib.request.urlopen(
                        self._request(url, "application/octet-stream"), timeout=120
                    ) as response:
                        return bytes(response.read(50_000_000))
                except (urllib.error.URLError, TimeoutError) as err:
                    raise UpdateError(f"Could not download {name}.") from err
        raise UpdateError(f"Release v{version} has no {name}.")


# --------------------------------------------------------------------------- docker


Runner = Callable[..., subprocess.CompletedProcess[str]]


def default_runner(argv: Sequence[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
    kwargs.setdefault("capture_output", True)
    kwargs.setdefault("text", True)
    kwargs.setdefault("check", False)
    return subprocess.run(list(argv), **kwargs)  # type: ignore[call-overload]  # noqa: S603


class Docker:
    """Compose commands for this install, with or without the release override."""

    def __init__(self, config: Config, runner: Runner = default_runner) -> None:
        self.config = config
        self.run = runner

    def _compose(self, release: bool) -> list[str]:
        cfg = self.config
        argv = ["docker", "compose", "-p", cfg.project, "--env-file", str(cfg.install_dir / ".env")]
        if release and cfg.version_env.is_file():
            argv += ["--env-file", str(cfg.version_env)]
        argv += ["-f", str(cfg.install_dir / "deploy/docker-compose.yml")]
        if release:
            argv += ["-f", str(cfg.install_dir / "deploy/docker-compose.release.yml")]
        if (cfg.install_dir / "certs/fullchain.pem").is_file():
            argv += ["-f", str(cfg.install_dir / "deploy/docker-compose.tls.yml")]
        return argv

    def compose(
        self, *args: str, release: bool = True, check: bool = True, **kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        result = self.run(
            [*self._compose(release), *args], cwd=str(self.config.install_dir), **kwargs
        )
        if check and result.returncode != 0:
            tail = ((result.stderr or "") + (result.stdout or "")).strip().splitlines()[-3:]
            raise UpdateError(f"docker compose {' '.join(args[:2])} failed: {' | '.join(tail)}")
        return result

    def login(self) -> None:
        cfg = self.config
        host = cfg.registry.split("/")[0]
        if not cfg.token:
            return
        result = self.run(
            ["docker", "login", host, "-u", cfg.github_user, "--password-stdin"], input=cfg.token
        )
        if result.returncode != 0:
            raise UpdateError(f"Could not sign in to {host} with the update token.")

    def image(self, name: str, version: str) -> str:
        return f"{self.config.registry}/atlas-{name}:{version}"

    def pull(self, version: str) -> None:
        for name in ("api", "web"):
            result = self.run(["docker", "pull", self.image(name, version)])
            if result.returncode != 0:
                tail = (result.stderr or "").strip().splitlines()[-1:]
                raise UpdateError(f"Could not pull {self.image(name, version)}: {' '.join(tail)}")

    def revision(self) -> str:
        result = self.compose(
            "exec", "-T", "db", "sh", "-c",
            'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select version_num from alembic_version"',
            check=False,
        )  # fmt: skip
        return result.stdout.strip() if result.returncode == 0 else ""

    def wait_healthy(self, version: str, timeout: int) -> None:
        probe = (
            "import json,urllib.request as u;"
            "r=json.load(u.urlopen('http://localhost:8000/health/ready',timeout=4));"
            "h=json.load(u.urlopen('http://localhost:8000/health',timeout=4));"
            "print(r.get('status'),h.get('version'))"
        )
        deadline = time.monotonic() + timeout
        last = ""
        while time.monotonic() < deadline:
            result = self.compose("exec", "-T", "api", "python", "-c", probe, check=False)
            lines = (result.stdout or result.stderr or "").strip().splitlines()
            last = lines[-1] if lines else ""
            if result.returncode == 0 and result.stdout.split()[:2] == ["ready", version]:
                return
            time.sleep(3)
        raise UpdateError(f"The new version did not become healthy within {timeout}s ({last or 'no answer'}).")


# --------------------------------------------------------------------------- the update


def free_bytes(path: Path) -> int:
    return shutil.disk_usage(path).free


def verify_checksum(data: bytes, sums: bytes, name: str) -> None:
    """Refuse ``data`` unless the release's ``SHA256SUMS`` lists ``name`` with the same SHA-256.

    This catches a corrupted or truncated download and an asset swapped without its checksum file.
    It does not defend against someone who controls the GitHub account (they publish both files).
    """
    wanted = ""
    for line in sums.decode("utf-8", errors="replace").splitlines():
        digest, _, listed = line.strip().partition("  ")
        if listed.strip().lstrip("*") == name:
            wanted = digest.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", wanted):
        raise UpdateError(f"The release's {CHECKSUMS_ASSET} does not list {name}; the update was stopped.")
    if hashlib.sha256(data).hexdigest() != wanted:
        raise UpdateError(f"{name} does not match its checksum; the update was stopped.")


def safe_members(archive: tarfile.TarFile) -> list[tarfile.TarInfo]:
    members = []
    for member in archive.getmembers():
        name = member.name.removeprefix("./")
        if not (member.isfile() or member.isdir()):
            raise UpdateError(f"The deploy bundle contains an unexpected entry: {name}")
        if name.startswith("/") or ".." in Path(name).parts:
            raise UpdateError(f"The deploy bundle contains an unsafe path: {name}")
        if name and not any(name == p.rstrip("/") or name.startswith(p) for p in DEPLOY_ALLOWED):
            continue
        member.name = name
        members.append(member)
    return members


class Updater:
    def __init__(
        self,
        config: Config,
        *,
        github: GitHub | None = None,
        docker: Docker | None = None,
        status: Status | None = None,
        free: Callable[[Path], int] = free_bytes,
    ) -> None:
        self.config = config
        self.github = github or GitHub(config)
        self.docker = docker or Docker(config)
        self.status = status or Status(config)
        self.free = free

    # ---- state on disk

    def current_version(self) -> str:
        path = self.config.version_env
        if path.is_file():
            for line in path.read_text().splitlines():
                if line.startswith("ATLAS_VERSION="):
                    value = line.split("=", 1)[1].strip()
                    if is_version(value):
                        return value
        return SOURCE_BUILD

    def _write_version_env(self, version: str | None) -> None:
        path = self.config.version_env
        if version is None:
            path.unlink(missing_ok=True)
            return
        tmp = path.with_suffix(".tmp")
        tmp.write_text(f"ATLAS_VERSION={version}\n")
        os.replace(tmp, path)

    # ---- check

    def check(self) -> None:
        current = self.current_version()
        self.status.set(current=current, message="")
        try:
            newest = self.github.newest()
        except UpdateError as err:
            self.status.set(message=str(err))
            raise
        if newest is None:
            self.status.set(latest=None, update_available=False, notes="", checked_at=self.status.now())
            return
        version, notes = newest
        self.status.set(
            latest=version,
            update_available=newer(version, current),
            notes=notes[:NOTES_LIMIT],
            checked_at=self.status.now(),
            message="",
        )

    # ---- apply

    def apply(self, target: str | None) -> None:
        if target is None:
            self.check()
            target = self.status.data.get("latest")  # type: ignore[assignment]
            if not target:
                raise UpdateError("There is no release to update to.")
        target = target.removeprefix("v")
        if not is_version(target):
            raise UpdateError("That is not a release version.")
        current = self.current_version()
        if not newer(target, current):
            raise UpdateError(f"Version {target} is not newer than {current}; downgrades are not supported.")
        if self.free(self.config.install_dir) < MIN_FREE_BYTES:
            raise UpdateError("Less than 1.5 GB of disk space is free on the server; free some space first.")

        self.status.set(
            state="updating", phase="preparing", started_at=self.status.now(), finished_at=None,
            message=f"Updating {current} to {target}", log=[],
        )  # fmt: skip
        previous_deploy = self.config.update_dir / "previous-deploy"
        switched = False
        old_revision = ""
        backup_sql = ""
        try:
            self._phase("download", f"Downloading the release files for {target}")
            bundle = self.github.asset(target, DEPLOY_ASSET)
            verify_checksum(bundle, self.github.asset(target, CHECKSUMS_ASSET), DEPLOY_ASSET)
            staging = Path(tempfile.mkdtemp(prefix="deploy-", dir=self.config.update_dir))
            with tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz") as archive:
                archive.extractall(staging, members=safe_members(archive), filter="data")  # noqa: S202
            for needed in ("deploy/docker-compose.yml", "deploy/docker-compose.release.yml"):
                if not (staging / needed).is_file():
                    raise UpdateError(f"The release's deploy bundle lacks {needed}.")

            self._phase("pull", "Pulling the new images (the application keeps running)")
            self.docker.login()
            self.docker.pull(target)

            self._phase("stop", "Stopping the application (the database keeps running)")
            self.docker.compose("up", "-d", "--no-build", "db", release=current != SOURCE_BUILD)
            old_revision = self.docker.revision()
            self.docker.compose("stop", "web", "api", "worker", release=current != SOURCE_BUILD)

            self._phase("backup", "Taking a verified backup of the database and the notes")
            backup_sql = self._backup(release=current != SOURCE_BUILD)

            self._phase("switch", "Switching to the new version")
            self._swap_deploy(staging, previous_deploy)
            switched = True
            self._write_version_env(target)
            self.docker.compose("up", "-d", "--no-build", "--remove-orphans")

            self._phase("health", "Waiting for the new version to start")
            self.docker.wait_healthy(target, self.config.health_timeout)
        except UpdateError as err:
            self.status.log(f"FAILED: {err}")
            self._rollback(current, switched, old_revision, backup_sql, previous_deploy, str(err))
            raise
        else:
            self._prune(keep={target, current})
            self.status.set(
                state="idle", phase=None, current=target, update_available=False,
                finished_at=self.status.now(), message=f"Updated to {target}",
            )  # fmt: skip
            self.status.log(f"Updated to {target}")

    def _phase(self, phase: str, line: str) -> None:
        self.status.set(phase=phase)
        self.status.log(line)

    def _backup(self, *, release: bool) -> str:
        result = self.docker.compose(
            "run", "--rm", "--no-deps", "-T", "worker", "atlas-backup", "run", release=release
        )
        path = re.search(r"directory: (/data/atlas/backups/atlas-backup-[\w.-]+)", result.stdout)
        if not path:
            raise UpdateError("Could not tell which backup set was written; the update was stopped.")
        verify = self.docker.compose(
            "run", "--rm", "--no-deps", "-T", "worker", "atlas-backup", "verify", path.group(1),
            release=release, check=False,
        )  # fmt: skip
        if verify.returncode != 0:
            raise UpdateError("The backup did not verify; the update was stopped before any change.")
        self.status.log(f"Backup verified: {path.group(1).rsplit('/', 1)[-1]}")
        return f"{path.group(1)}/database.sql"

    def _swap_deploy(self, staging: Path, previous: Path) -> None:
        shutil.rmtree(previous, ignore_errors=True)
        previous.mkdir(parents=True)
        for rel in ("deploy", "apps/web/nginx.conf", "apps/web/nginx.tls.conf"):
            source = self.config.install_dir / rel
            if source.exists():
                destination = previous / rel
                destination.parent.mkdir(parents=True, exist_ok=True)
                if source.is_dir():
                    shutil.copytree(source, destination, ignore=shutil.ignore_patterns("tls"))
                else:
                    shutil.copy2(source, destination)
        for rel in ("deploy", "apps/web/nginx.conf", "apps/web/nginx.tls.conf"):
            new = staging / rel
            if not new.exists():
                continue
            target = self.config.install_dir / rel
            if new.is_dir():
                shutil.copytree(new, target, dirs_exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(new, target)
        shutil.rmtree(staging, ignore_errors=True)

    def _rollback(
        self, current: str, switched: bool, old_revision: str, backup_sql: str, previous: Path, reason: str
    ) -> None:
        release_before = current != SOURCE_BUILD
        self.status.set(phase="rollback")
        self.status.log("Starting the previous version again")
        try:
            if switched:
                self.docker.compose("stop", "web", "api", "worker", check=False)
                new_revision = self.docker.revision()
                if backup_sql and old_revision and new_revision != old_revision:
                    self.status.log("The new version had migrated the database; restoring the backup")
                    self._restore_database(backup_sql)
                    restored = True
                else:
                    restored = False
                if previous.is_dir():
                    for rel in ("deploy", "apps/web/nginx.conf", "apps/web/nginx.tls.conf"):
                        old = previous / rel
                        if old.is_dir():
                            shutil.copytree(old, self.config.install_dir / rel, dirs_exist_ok=True)
                        elif old.is_file():
                            shutil.copy2(old, self.config.install_dir / rel)
                self._write_version_env(current if release_before else None)
            else:
                restored = False
            self.docker.compose("up", "-d", "--no-build", release=release_before)
            if release_before:
                self.docker.wait_healthy(current, self.config.health_timeout)
            if restored:
                self.docker.compose("exec", "-T", "api", "atlas-admin", "record-restore", release=release_before, check=False)
            self.status.log(f"Version {current} is running again")
            self.status.set(
                state="rolled_back", phase=None, finished_at=self.status.now(),
                message=f"The update to the new version failed and {current} is running again, with your data as before. Reason: {reason}",
            )  # fmt: skip
        except UpdateError as err:
            self.status.set(
                state="failed", phase=None, finished_at=self.status.now(),
                message=(
                    "The update failed and the previous version could not be restarted automatically "
                    f"({err}). Your data is safe: the backup is in the atlas-backups volume. See docs/OPERATIONS.md section 2.7."
                ),
            )  # fmt: skip

    def _restore_database(self, backup_sql: str) -> None:
        cfg = self.docker
        sh = 'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "{}"'
        cfg.compose("exec", "-T", "db", "sh", "-c", sh.format('DROP DATABASE IF EXISTS atlas_restoring'))
        cfg.compose("exec", "-T", "db", "sh", "-c", sh.format('CREATE DATABASE atlas_restoring'))
        dump = cfg.compose("run", "--rm", "--no-deps", "-T", "worker", "cat", backup_sql)
        load = cfg.run(
            [*cfg._compose(True), "exec", "-T", "db", "sh", "-c",
             'psql -U "$POSTGRES_USER" -d atlas_restoring -v ON_ERROR_STOP=1 -q'],
            input=dump.stdout, cwd=str(self.config.install_dir),
        )  # fmt: skip
        if load.returncode != 0:
            cfg.compose("exec", "-T", "db", "sh", "-c", sh.format("DROP DATABASE IF EXISTS atlas_restoring"), check=False)
            raise UpdateError("Restoring the backup failed; the live database was not touched.")
        # Swap only after the dump loaded cleanly: the live database is replaced, never half-written.
        cfg.compose(
            "exec", "-T", "db", "sh", "-c",
            'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 '
            '-c "ALTER DATABASE \\"$POSTGRES_DB\\" RENAME TO atlas_replaced" '
            '-c "ALTER DATABASE atlas_restoring RENAME TO \\"$POSTGRES_DB\\"" '
            '-c "DROP DATABASE atlas_replaced"',
        )  # fmt: skip

    def _prune(self, keep: set[str]) -> None:
        """Remove Atlas images older than the two that matter (the server's disk is small).

        The version that just ran and the one before stay; a newer image (not installed yet) is never touched.
        """
        oldest = min(parse_version(v) for v in keep)
        result = self.docker.run(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"])
        for name in result.stdout.splitlines():
            for kind in ("api", "web"):
                prefix = f"{self.config.registry}/atlas-{kind}:"
                tag = name.removeprefix(prefix)
                if name.startswith(prefix) and is_version(tag) and parse_version(tag) < oldest:
                    self.docker.run(["docker", "image", "rm", name])

    # ---- requests from the web app

    def handle_request(self) -> None:
        path = self.config.request_path
        try:
            request = json.loads(path.read_text())
        except (OSError, ValueError):
            path.unlink(missing_ok=True)
            return
        path.unlink(missing_ok=True)  # first, so a crash can never re-run it in a loop
        action = request.get("action") if isinstance(request, dict) else None
        if action == "check":
            self.check()
        elif action == "apply":
            version = request.get("version")
            if not is_version(version):
                raise UpdateError("The request named no valid version.")
            self.status.set(state="updating", phase="validating", message="Validating the request")
            self.check()  # the newest release is decided here, from GitHub, never taken from the request
            if self.status.data.get("latest") != version:
                self.status.set(state="idle", phase=None, message="That is not the newest release; nothing was changed.")
                raise UpdateError("The requested version is not the newest release.")
            self.apply(version)


def main(argv: Sequence[str]) -> int:
    install = Path(os.environ.get("ATLAS_INSTALL_DIR", Path.home() / "atlas"))
    env_file = Path(os.environ.get("ATLAS_UPDATER_ENV", Path.home() / ".config/atlas-updater/env"))
    config = load_config(install, env_file)
    config.update_dir.mkdir(parents=True, exist_ok=True)
    command = argv[1] if len(argv) > 1 else "check"
    with open(config.update_dir / ".lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("another update is running", file=sys.stderr)
            return 75
        updater = Updater(config)
        try:
            if command == "check":
                updater.check()
            elif command == "request":
                updater.handle_request()
            elif command == "apply":
                updater.apply(argv[2] if len(argv) > 2 else None)
            else:
                print(__doc__)
                return 2
        except UpdateError as err:
            print(f"atlas-updater: {err}", file=sys.stderr)
            if updater.status.data.get("state") == "updating":
                updater.status.set(state="failed", message=str(err), finished_at=updater.status.now())
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
