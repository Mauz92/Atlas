"""The shipped web container's nginx must let a maximum-size note through (R-34, SYNC-03).

A note may be ``MAX_NOTE_BYTES`` (5 MiB) and is sent to ``/api/`` as JSON. nginx's default
``client_max_body_size`` is 1 MiB, which silently capped saved notes at about 1 MiB through the
shipped container (found by SYNC-01 d, a real defect). Two layers of checking:

- a **static** check parses ``apps/web/nginx.conf`` (always runs, no Docker): the directive in
  ``location /api/`` must cover ``MAX_NOTE_BYTES`` plus JSON overhead, and the limit elsewhere must
  stay small;
- a **live probe** (skipped when Docker or the ``nginx:1.27-alpine`` image is unavailable; it never
  pulls an image and never touches any running container) starts a throwaway container with the
  shipped file and posts real bodies of several sizes.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import httpx
import pytest

from atlas.notes.storage import MAX_NOTE_BYTES

NGINX_CONF = Path(__file__).resolve().parents[4] / "apps" / "web" / "nginx.conf"
NGINX_IMAGE = "nginx:1.27-alpine"
MIB = 1024 * 1024
#: Room for the JSON envelope (``{"content": "...", "base_revision": n}``).
JSON_OVERHEAD = 64 * 1024
#: JSON escapes a newline, tab, quote or backslash as two bytes, so the worst plain-text body is
#: twice the note (control characters cost six and are not counted).
ESCAPE_FACTOR = 2
SMALL_DEFAULT_LIMIT = 2 * MIB

_SIZE = re.compile(r"^(\d+)([kKmMgG]?)$")


def _bytes(value: str) -> int:
    match = _SIZE.match(value)
    assert match, f"unparseable size {value!r}"
    unit = {"": 1, "k": 1024, "m": MIB, "g": 1024 * MIB}[match.group(2).lower()]
    return int(match.group(1)) * unit


def _blocks(conf: str) -> dict[str, str]:
    """Each ``location`` body (brace matched) by path; ``""`` is what is left at server level."""
    out: dict[str, str] = {}
    for match in re.finditer(r"location\s+(\S+)\s*\{", conf):
        depth, index = 1, match.end()
        while depth:
            depth += {"{": 1, "}": -1}.get(conf[index], 0)
            index += 1
        out[match.group(1)] = conf[match.end() : index - 1]
    stripped = conf
    for body in out.values():
        stripped = stripped.replace(body, "")
    out[""] = stripped
    return out


def _limit(block: str) -> int | None:
    found = re.search(r"^\s*client_max_body_size\s+(\S+?)\s*;", block, re.MULTILINE)
    return _bytes(found.group(1)) if found else None


def test_api_location_allows_a_maximum_size_note_plus_json_overhead() -> None:
    blocks = _blocks(NGINX_CONF.read_text(encoding="utf-8"))
    limit = _limit(blocks["/api/"])
    assert limit is not None, "location /api/ must set client_max_body_size explicitly"
    assert limit >= ESCAPE_FACTOR * MAX_NOTE_BYTES + JSON_OVERHEAD, (
        f"/api/ allows {limit} bytes; a {MAX_NOTE_BYTES}-byte note of newlines/quotes needs "
        f"{ESCAPE_FACTOR * MAX_NOTE_BYTES + JSON_OVERHEAD} once JSON-escaped"
    )


def test_the_limit_stays_small_everywhere_else() -> None:
    blocks = _blocks(NGINX_CONF.read_text(encoding="utf-8"))
    server_limit = _limit(blocks[""])
    assert server_limit is not None, "set a small server-level client_max_body_size explicitly"
    assert server_limit <= SMALL_DEFAULT_LIMIT
    for path, body in blocks.items():
        if path in ("", "/api/"):
            continue
        limit = _limit(body)
        assert limit is None or limit <= SMALL_DEFAULT_LIMIT, f"location {path} raises the limit"


def test_the_parser_rejects_the_pre_fix_configuration() -> None:
    """Negative control: nginx's implicit 1 MiB default (no directive) must fail the check."""
    old = "server { location /api/ { proxy_pass http://api:8000; } location / { } }"
    assert _limit(_blocks(old)["/api/"]) is None


# --- live probe ----------------------------------------------------------------------------


def _docker_ready() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        probe = subprocess.run(
            ["docker", "image", "inspect", NGINX_IMAGE],
            capture_output=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return probe.returncode == 0


@pytest.mark.skipif(
    not _docker_ready(), reason=f"docker or the local {NGINX_IMAGE} image is unavailable"
)
def test_shipped_nginx_accepts_a_maximum_note_and_still_rejects_large_bodies_elsewhere() -> None:
    name = f"atlas-nginx-probe-{uuid.uuid4().hex[:8]}"
    run = subprocess.run(
        [
            "docker", "run", "-d", "--rm", "--name", name,
            # The config proxies to host ``api``; point it at a closed local port, so an accepted
            # body ends in 502 (nothing listens) while a rejected one is answered 413 by nginx.
            "--add-host", "api:127.0.0.1",
            "-v", f"{NGINX_CONF}:/etc/nginx/conf.d/default.conf:ro",
            "-p", "127.0.0.1::80",
            NGINX_IMAGE,
        ],
        capture_output=True, text=True, timeout=60, check=False,
    )  # fmt: skip
    assert run.returncode == 0, run.stderr
    try:
        port = (
            subprocess.run(
                ["docker", "port", name, "80/tcp"],
                capture_output=True,
                text=True,
                timeout=20,
                check=True,
            )
            .stdout.splitlines()[0]
            .rsplit(":", 1)[1]
        )
        base = f"http://127.0.0.1:{port}"

        def post(path: str, size: int) -> int:
            return httpx.post(base + path, content=b"x" * size, timeout=30).status_code

        deadline = time.monotonic() + 15
        while True:
            try:
                httpx.get(base + "/", timeout=2)
                break
            except httpx.TransportError:
                assert time.monotonic() < deadline, "nginx did not start"
                time.sleep(0.2)

        assert post("/api/notes", MAX_NOTE_BYTES + 1024) != 413, "a maximum note is rejected"
        worst_case = ESCAPE_FACTOR * MAX_NOTE_BYTES + JSON_OVERHEAD
        assert post("/api/notes", worst_case) != 413, "an all-newlines maximum note is rejected"
        assert post("/api/notes", 12 * MIB) == 413, "bodies well above the cap are still refused"
        assert post("/not-the-api", 2 * MIB + 1) == 413, "the limit outside /api/ stays small"
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=30, check=False)
