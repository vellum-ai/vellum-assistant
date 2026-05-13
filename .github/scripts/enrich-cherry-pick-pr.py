#!/usr/bin/env python3
"""Enrich a cherry-pick PR body with Linear issue references.

Purpose
=======

The `cherry-pick-to-release.yml` workflow accumulates multiple cherry-picks
into a single PR per release branch. When that PR squash-merges onto the
release branch, the squash commit body contains only the *titles* of the
cherry-picked commits — not their bodies. So any Linear identifiers that were
referenced in the original PRs' bodies are lost.

The Linear Release CLI scans commit messages for Linear identifiers (e.g.
``LUM-NNNN``) only when preceded by a magic word (``Closes``, ``Fixes``,
``Resolves``, ``Part of``, ``Refs``, ...). Bare mentions are ignored. See:

  https://github.com/linear/linear-release/blob/main/src/extractors.ts

This script rebuilds the cherry-pick PR body with a structured "Linear refs"
section that lists each cherry-picked PR along with any Linear identifiers
found in that PR's title/body, each prefixed with the magic word "Closes".
When the cherry-pick PR is squash-merged, those references end up in the
squash commit body where the Linear Release CLI can extract them.

Discovery sources, in priority order
------------------------------------

1. **Linear `attachmentsForURL` GraphQL query** (only when `LINEAR_API_KEY`
   env var is set): asks Linear "what issues are linked to this GitHub PR?".
   This catches PRs that were linked via Linear's Development panel even if
   their body doesn't mention an issue identifier.

2. **Regex scan of the original PR's title + body**: matches any
   `<PREFIX>-<NUMBER>` style identifier. Catches PRs that reference Linear in
   prose but weren't manually linked in Linear.

If both sources are exhausted and yield no identifiers, the PR is listed
under "## Cherry-picks" without a `Closes` line.

Idempotency
-----------

The script wraps its output in HTML comments
(`<!-- linear-refs:start -->` / `<!-- linear-refs:end -->`) so subsequent
invocations replace the previous block in place rather than duplicating it.
Other content in the PR body is preserved.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Iterable

# Linear team prefixes in the Vellum workspace. Update this list if a new
# Linear team is added. Restricting to a known allowlist avoids false
# positives from arbitrary acronyms like `HTTP-200` showing up in PR bodies.
LINEAR_TEAM_PREFIXES = ("LUM", "ATL", "JARVIS")
LINEAR_ID_PATTERN = re.compile(
    r"\b(" + "|".join(LINEAR_TEAM_PREFIXES) + r")-(\d{1,9})\b"
)

REFS_BLOCK_START = "<!-- linear-refs:start -->"
REFS_BLOCK_END = "<!-- linear-refs:end -->"
REFS_BLOCK_RE = re.compile(
    re.escape(REFS_BLOCK_START) + r".*?" + re.escape(REFS_BLOCK_END),
    re.DOTALL,
)


def sh(cmd: list[str]) -> str:
    """Run a command and return its stdout. Raises on non-zero exit."""
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        sys.stderr.write(
            f"command failed ({result.returncode}): {' '.join(cmd)}\n"
            f"stderr: {result.stderr}\n"
        )
        result.check_returncode()
    return result.stdout


def list_cherry_picked_pr_numbers(release_branch: str) -> list[int]:
    """Return PR numbers whose squash commits are present on HEAD but not on
    the release branch — i.e. the PRs cherry-picked so far on this branch.

    Each main-merged squash commit looks like:
        feat(foo): description (#12345)
    We extract the trailing `(#NNN)`.
    """
    raw = sh(
        [
            "git",
            "log",
            f"origin/{release_branch}..HEAD",
            "--format=%s",
        ]
    ).splitlines()

    seen: set[int] = set()
    ordered: list[int] = []
    for line in raw:
        match = re.search(r"\(#(\d+)\)\s*$", line.strip())
        if match:
            pr = int(match.group(1))
            if pr not in seen:
                seen.add(pr)
                ordered.append(pr)
    # Most-recent first feels confusing; show in chronological order
    # (`git log` already returns newest-first, so reverse).
    return list(reversed(ordered))


def fetch_pr_metadata(pr_number: int) -> dict:
    """Fetch a PR's title, body, and URL via the GitHub CLI."""
    raw = sh(
        [
            "gh",
            "pr",
            "view",
            str(pr_number),
            "--json",
            "number,title,body,url",
        ]
    )
    return json.loads(raw)


def regex_linear_ids(text: str) -> list[str]:
    """Extract Linear identifiers (prefix in LINEAR_TEAM_PREFIXES) from text."""
    if not text:
        return []
    ids: list[str] = []
    seen: set[str] = set()
    for match in LINEAR_ID_PATTERN.finditer(text):
        identifier = f"{match.group(1)}-{match.group(2)}"
        if identifier not in seen:
            seen.add(identifier)
            ids.append(identifier)
    return ids


def linear_attachments_for_url(pr_url: str, api_key: str) -> list[str]:
    """Query Linear for issues whose attachments point at `pr_url`.

    Catches PRs that were manually linked to Linear issues via Linear's
    Development panel even if neither title nor body mentions the issue.

    Returns an empty list on any error or unset API key.
    """
    if not api_key:
        return []

    import urllib.error
    import urllib.request

    query = """
    query AttachmentsForURL($url: String!) {
      attachmentsForURL(url: $url, first: 50) {
        nodes {
          issue { identifier }
        }
      }
    }
    """
    body = json.dumps({"query": query, "variables": {"url": pr_url}}).encode()
    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": api_key,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.load(resp)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
        sys.stderr.write(f"linear api: {pr_url}: {exc}\n")
        return []
    except json.JSONDecodeError as exc:
        sys.stderr.write(f"linear api: malformed response for {pr_url}: {exc}\n")
        return []

    nodes = (
        payload.get("data", {})
        .get("attachmentsForURL", {})
        .get("nodes", [])
        or []
    )
    seen: set[str] = set()
    out: list[str] = []
    for node in nodes:
        ident = (node.get("issue") or {}).get("identifier")
        if ident and ident not in seen:
            seen.add(ident)
            out.append(ident)
    return out


def resolve_linear_ids(pr: dict, api_key: str) -> tuple[list[str], list[str]]:
    """Resolve Linear IDs for a PR. Returns (identifiers, source_labels)."""
    identifiers: list[str] = []
    sources: list[str] = []

    api_ids = linear_attachments_for_url(pr["url"], api_key)
    if api_ids:
        identifiers.extend(api_ids)
        sources.append("Linear Development panel")

    text = (pr.get("title") or "") + "\n" + (pr.get("body") or "")
    regex_ids = [i for i in regex_linear_ids(text) if i not in identifiers]
    if regex_ids:
        identifiers.extend(regex_ids)
        sources.append("PR body scan")

    return identifiers, sources


def render_block(prs: Iterable[dict], api_key: str) -> str:
    """Render the enrichment block as Markdown."""
    lines = [REFS_BLOCK_START, "", "## Linear refs", ""]
    lines.append(
        "Resolved automatically from the original main PRs for each "
        "cherry-pick. The `Closes <ID>` lines below land in the squash "
        "commit body when this PR merges, so the Linear Release CLI can "
        "attribute issues to this release. See "
        "[`enrich-cherry-pick-pr.py`](.github/scripts/enrich-cherry-pick-pr.py)."
    )
    lines.append("")

    any_resolved = False
    for pr in prs:
        identifiers, sources = resolve_linear_ids(pr, api_key)
        if identifiers:
            any_resolved = True

        title = pr.get("title") or f"PR #{pr['number']}"
        lines.append(f"- #{pr['number']} — {title}")
        if identifiers:
            for ident in identifiers:
                lines.append(f"  - Closes {ident}")
            lines.append(f"  - _Source: {', '.join(sources)}_")
        else:
            lines.append("  - _No Linear identifiers found_")

    if not any_resolved:
        lines.append("")
        lines.append(
            "_No Linear identifiers resolved for any cherry-pick on this "
            "branch. The release will be created in Linear but no issues "
            "will be attached._"
        )

    lines.append("")
    lines.append(REFS_BLOCK_END)
    return "\n".join(lines)


def upsert_block(body: str, block: str) -> str:
    """Insert or replace the linear-refs block in `body`."""
    if REFS_BLOCK_START in body and REFS_BLOCK_END in body:
        return REFS_BLOCK_RE.sub(block, body, count=1)
    suffix = "\n\n" + block if body.strip() else block
    return body.rstrip() + suffix


def main() -> int:
    cherry_pick_pr = os.environ.get("CHERRY_PICK_PR_NUMBER")
    release_branch = os.environ.get("RELEASE_BRANCH")
    api_key = os.environ.get("LINEAR_API_KEY", "")

    if not cherry_pick_pr or not release_branch:
        sys.stderr.write(
            "missing CHERRY_PICK_PR_NUMBER or RELEASE_BRANCH env var\n"
        )
        return 2

    pr_numbers = list_cherry_picked_pr_numbers(release_branch)
    if not pr_numbers:
        sys.stderr.write(
            f"no cherry-picked PRs found between origin/{release_branch} and "
            "HEAD; nothing to enrich\n"
        )
        return 0

    print(f"enriching cherry-pick PR #{cherry_pick_pr} with refs from "
          f"{len(pr_numbers)} cherry-picked PR(s): "
          f"{', '.join(f'#{n}' for n in pr_numbers)}")

    prs = [fetch_pr_metadata(n) for n in pr_numbers]
    block = render_block(prs, api_key)

    current_body = json.loads(
        sh(["gh", "pr", "view", cherry_pick_pr, "--json", "body"])
    )["body"] or ""
    new_body = upsert_block(current_body, block)

    if new_body == current_body:
        print("body unchanged; no update needed")
        return 0

    sh(["gh", "pr", "edit", cherry_pick_pr, "--body", new_body])
    print(f"updated cherry-pick PR #{cherry_pick_pr}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
