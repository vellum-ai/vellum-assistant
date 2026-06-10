"""
Pure-function mock for the subset of the GitHub Contents + Raw APIs
that the assistant's `assistant plugins install` flow depends on.

The mitmproxy addon (`addon.py`) calls into `handle()` from its
`request` hook. When the handler returns a response tuple, the addon
short-circuits the request (no upstream egress required); when it
returns `None`, the request falls through to mitmproxy's normal
upstream path. That way the same addon can mock GitHub while still
forwarding model-provider traffic to the real API.

Scope is deliberately tight: we recognize only

  - `GET api.github.com/repos/vellum-ai/vellum-assistant/contents/<path>?ref=<ref>`
  - `GET raw.githubusercontent.com/vellum-ai/vellum-assistant/<ref>/<path>`

and only when `<path>` is rooted under `plugins/`. The
assistant's CLI plugin loader (`assistant/src/cli/lib/install-from-github.ts`)
hits exactly these two endpoints; anything else from the assistant
falls through and gets dropped by the iptables DROP-default policy.

No mitmproxy import here — the module is testable as a pure function
via `test_mock_github_handler.py` (plain `unittest`, no fixtures
server).
"""

from __future__ import annotations

import json
import os
import re
from typing import Optional, Tuple
from urllib.parse import unquote, urlsplit


PLUGIN_OWNER = "vellum-ai"
PLUGIN_REPO = "vellum-assistant"
PLUGIN_PATH_PREFIX = "plugins"


def _safe_join(fixtures_dir: str, relative: str) -> Optional[str]:
    """Resolve `relative` under `fixtures_dir`, refusing escape.

    The fixtures dir is the source of truth for what plugins exist;
    nothing the assistant container can request via URL should be
    able to read outside it. `os.path.normpath` collapses `..`
    segments before we compare against the prefix, so a path like
    `../../etc/passwd` resolves to a string that doesn't start with
    the (normalized) fixtures-dir prefix and we return None.
    """
    target = os.path.normpath(os.path.join(fixtures_dir, relative))
    fixtures_norm = os.path.normpath(fixtures_dir)
    if target == fixtures_norm or target.startswith(fixtures_norm + os.sep):
        return target
    return None


def _entry_from_disk(
    *,
    name: str,
    repo_relative_path: str,
    on_disk_path: str,
) -> Optional[dict]:
    """Build one GitHub-Contents-API entry from a filesystem item.

    Returns the entry dict for files/dirs, `None` for anything else
    (symlinks, sockets, etc.) so we never reflect non-portable
    filesystem objects into a synthetic API response.
    """
    if os.path.isdir(on_disk_path):
        return {
            "name": name,
            "path": repo_relative_path,
            "type": "dir",
            "size": 0,
            "download_url": None,
        }
    if os.path.isfile(on_disk_path):
        return {
            "name": name,
            "path": repo_relative_path,
            "type": "file",
            "size": os.path.getsize(on_disk_path),
            # The install loader follows `download_url` directly,
            # which the iptables NAT REDIRECT bounces back through
            # mitmproxy — same addon will then serve the raw path
            # below from `handle_raw_api`.
            "download_url": (
                f"https://raw.githubusercontent.com/"
                f"{PLUGIN_OWNER}/{PLUGIN_REPO}/main/{repo_relative_path}"
            ),
        }
    return None


def handle_contents_api(
    *,
    method: str,
    url: str,
    fixtures_dir: str,
) -> Optional[Tuple[int, str, bytes]]:
    """Mock `GET api.github.com/repos/<owner>/<repo>/contents/<path>?ref=<ref>`.

    Returns:
        - 404 + JSON for paths outside `plugins/`, missing
          targets, or escape attempts.
        - 200 + JSON array for directories (one entry per child).
        - 200 + JSON object for a single file (matches GitHub's actual
          single-file response shape).
        - `None` when the URL doesn't match the contents API for
          `vellum-ai/vellum-assistant` — the addon should fall through.
    """
    if method != "GET":
        return None

    parts = urlsplit(url)
    if parts.netloc.lower() != "api.github.com":
        return None

    contents_re = re.compile(
        rf"^/repos/{re.escape(PLUGIN_OWNER)}/{re.escape(PLUGIN_REPO)}/contents/(.+)$"
    )
    match = contents_re.match(parts.path)
    if not match:
        return None

    repo_path = unquote(match.group(1))

    # Only serve paths under plugins/. The install loader
    # never asks for anything else, and refusing other paths up front
    # keeps the mock's surface minimal.
    if not (
        repo_path == PLUGIN_PATH_PREFIX
        or repo_path.startswith(PLUGIN_PATH_PREFIX + "/")
    ):
        return 404, "application/json", b'{"message": "Not Found"}'

    relative = repo_path[len(PLUGIN_PATH_PREFIX):].lstrip("/")
    target = _safe_join(fixtures_dir, relative)
    if target is None or not os.path.exists(target):
        return 404, "application/json", b'{"message": "Not Found"}'

    if os.path.isdir(target):
        entries = []
        for name in sorted(os.listdir(target)):
            entry_rel = (
                f"{repo_path}/{name}" if repo_path else name
            )
            entry = _entry_from_disk(
                name=name,
                repo_relative_path=entry_rel,
                on_disk_path=os.path.join(target, name),
            )
            if entry is not None:
                entries.append(entry)
        return 200, "application/json", json.dumps(entries).encode("utf-8")

    if os.path.isfile(target):
        entry = _entry_from_disk(
            name=os.path.basename(target),
            repo_relative_path=repo_path,
            on_disk_path=target,
        )
        if entry is None:  # pragma: no cover -- isfile() just succeeded
            return 404, "application/json", b'{"message": "Not Found"}'
        return 200, "application/json", json.dumps(entry).encode("utf-8")

    return 404, "application/json", b'{"message": "Not Found"}'


def handle_raw_api(
    *,
    method: str,
    url: str,
    fixtures_dir: str,
) -> Optional[Tuple[int, str, bytes]]:
    """Mock `GET raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`.

    Returns:
        - 404 for paths outside `plugins/`, missing files,
          escape attempts, or non-file targets.
        - 200 + raw file bytes for matching files.
        - `None` when the URL doesn't match the raw API for
          `vellum-ai/vellum-assistant`.
    """
    if method != "GET":
        return None
    parts = urlsplit(url)
    if parts.netloc.lower() != "raw.githubusercontent.com":
        return None

    raw_re = re.compile(
        rf"^/{re.escape(PLUGIN_OWNER)}/{re.escape(PLUGIN_REPO)}/[^/]+/(.+)$"
    )
    match = raw_re.match(parts.path)
    if not match:
        return None

    repo_path = unquote(match.group(1))
    if not repo_path.startswith(PLUGIN_PATH_PREFIX + "/"):
        return 404, "application/octet-stream", b""

    relative = repo_path[len(PLUGIN_PATH_PREFIX):].lstrip("/")
    target = _safe_join(fixtures_dir, relative)
    if target is None or not os.path.isfile(target):
        return 404, "application/octet-stream", b""

    with open(target, "rb") as fh:
        return 200, "application/octet-stream", fh.read()


def handle(
    *,
    method: str,
    url: str,
    fixtures_dir: str,
) -> Optional[Tuple[int, str, bytes]]:
    """Dispatch to the contents/raw handlers in order.

    The two URL shapes are mutually exclusive (different hostnames),
    so the order is just a cheap-first preference — `None` from one
    means "wrong endpoint, try the other or fall through".
    """
    result = handle_contents_api(method=method, url=url, fixtures_dir=fixtures_dir)
    if result is not None:
        return result
    return handle_raw_api(method=method, url=url, fixtures_dir=fixtures_dir)
