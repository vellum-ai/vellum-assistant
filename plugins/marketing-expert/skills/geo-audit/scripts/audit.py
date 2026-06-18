#!/usr/bin/env python3
"""
geo-audit — a one-command technical GEO audit for any domain.

Usage:
    python3 audit.py <domain> [--json] [--no-color] [--timeout N]

Examples:
    python3 audit.py vellum.ai
    python3 audit.py https://stripe.com --json
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field, asdict
from typing import Callable

UA = "Mozilla/5.0 (geo-audit/1.0; +https://vellum.ai)"
TIMEOUT_DEFAULT = 10

AI_AGENTS = [
    "GPTBot",
    "ChatGPT-User",
    "OAI-SearchBot",
    "ClaudeBot",
    "anthropic-ai",
    "PerplexityBot",
    "Perplexity-User",
    "Google-Extended",
    "CCBot",
]

# Crude positive signal words for SSR check. We're looking for *some* meaningful
# content in the initial HTML before JS — not a full semantic parse.
SSR_HINTS = ["<h1", "<main", "<article", "<title", "og:title", "og:description"]


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

class Color:
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    RED = "\033[31m"
    DIM = "\033[2m"
    BOLD = "\033[1m"
    RESET = "\033[0m"

    enabled = True

    @classmethod
    def disable(cls):
        cls.enabled = False

    @classmethod
    def wrap(cls, s: str, code: str) -> str:
        if not cls.enabled:
            return s
        return f"{code}{s}{cls.RESET}"


def normalize_domain(raw: str) -> tuple[str, str]:
    """Return (origin, host). origin includes scheme. host is just the netloc."""
    raw = raw.strip()
    if not raw.startswith(("http://", "https://")):
        raw = "https://" + raw
    parsed = urllib.parse.urlparse(raw)
    host = parsed.netloc
    if not host:
        host = parsed.path
        parsed = urllib.parse.urlparse("https://" + host)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    return origin, parsed.netloc


def fetch(url: str, timeout: int = TIMEOUT_DEFAULT, max_redirects: int = 5) -> tuple[int, str, dict]:
    """Return (status_code, body_text, headers). Errors return (0, "", {}).

    Follows redirects manually so we can handle 308/307 and cross-host hops
    (urllib's default opener handles most but trips on some 308 Permanent
    Redirect chains).
    """
    current = url
    seen: set[str] = set()
    for _ in range(max_redirects + 1):
        if current in seen:
            break
        seen.add(current)
        req = urllib.request.Request(current, headers={"User-Agent": UA, "Accept": "*/*"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                return resp.status, body, dict(resp.headers)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308):
                location = (e.headers or {}).get("Location")
                if location:
                    current = urllib.parse.urljoin(current, location)
                    continue
            return e.code, "", dict(e.headers or {})
        except Exception:
            return 0, "", {}
    return 0, "", {}


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------

@dataclass
class CheckResult:
    name: str
    score: int
    max_score: int
    findings: list[str] = field(default_factory=list)
    fix: str | None = None
    fix_impact: int = 0       # 1-5
    fix_effort: int = 3       # 1-5 (lower = easier)

    @property
    def verdict(self) -> str:
        ratio = self.score / self.max_score if self.max_score else 0
        if ratio >= 0.85:
            return "ok"
        if ratio >= 0.5:
            return "warn"
        return "fail"


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def check_robots(origin: str, timeout: int) -> CheckResult:
    """25 pts. Parse robots.txt, score AI crawler permissions."""
    r = CheckResult(name="AI crawler access", score=0, max_score=25)
    status, body, _ = fetch(f"{origin}/robots.txt", timeout=timeout)
    if status != 200 or not body.strip():
        r.findings.append("No robots.txt found — agents default to allowed, but the signal is muddy.")
        # Without a robots.txt, AI agents *technically* get unrestricted access.
        # Give partial credit but flag.
        r.score = 18
        r.fix = "Add a robots.txt that explicitly allows AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot)."
        r.fix_impact = 3
        r.fix_effort = 1
        return r

    # Parse robots.txt: we read in user-agent groups and check Allow/Disallow per agent.
    groups: dict[str, list[str]] = {}
    current_agents: list[str] = []
    for raw_line in body.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            current_agents = []
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip().lower()
        value = value.strip()
        if key == "user-agent":
            current_agents.append(value)
            groups.setdefault(value, [])
        elif key in ("allow", "disallow") and current_agents:
            for ag in current_agents:
                groups.setdefault(ag, []).append(f"{key}:{value}")

    blocked = []
    allowed = []
    silent = []  # not mentioned; falls back to wildcard
    wildcard_disallows_root = any(d == "disallow:/" for d in groups.get("*", []))

    for agent in AI_AGENTS:
        rules = groups.get(agent)
        if rules is None:
            if wildcard_disallows_root:
                blocked.append(agent)
            else:
                silent.append(agent)
            continue
        # If we see any "disallow:/" with no overriding allow, count as blocked.
        if any(rule == "disallow:/" for rule in rules) and not any(
            rule.startswith("allow:") for rule in rules
        ):
            blocked.append(agent)
        else:
            allowed.append(agent)

    # Scoring: 25 base, -3 per blocked agent, +0 for silent, full credit if all explicit & allowed.
    score = 25 - 3 * len(blocked)
    if score < 0:
        score = 0
    r.score = score

    if blocked:
        r.findings.append(f"Blocked: {', '.join(blocked)}")
    if silent and not blocked:
        r.findings.append(
            f"Not explicitly named (fine, but adding them removes ambiguity): {', '.join(silent[:4])}"
            + ("…" if len(silent) > 4 else "")
        )
    if not blocked and not silent:
        r.findings.append("All major AI crawlers explicitly allowed.")

    if blocked:
        r.fix = f"Unblock AI agents in robots.txt: {', '.join(blocked)}."
        r.fix_impact = 5
        r.fix_effort = 1
    elif silent:
        r.fix = "Add explicit Allow lines for the major AI crawlers in robots.txt."
        r.fix_impact = 2
        r.fix_effort = 1
    return r


def check_llms_txt(origin: str, timeout: int) -> CheckResult:
    r = CheckResult(name="llms.txt", score=0, max_score=15)
    status, body, _ = fetch(f"{origin}/llms.txt", timeout=timeout)
    if status != 200 or not body.strip():
        r.findings.append("No llms.txt at the domain root.")
        r.fix = "Stand up a curated /llms.txt with your product overview, pricing, top comparisons, and pillar pages."
        r.fix_impact = 4
        r.fix_effort = 1
        return r

    score = 5  # exists
    if re.search(r"^#\s+\S+", body, re.MULTILINE):
        score += 3
        r.findings.append("Has a top-level title.")
    else:
        r.findings.append("Missing top-level # title.")

    links = re.findall(r"\]\((https?://[^\s\)]+)\)", body)
    if links:
        score += 4
        r.findings.append(f"Lists {len(links)} link(s).")
        # Spot-check up to 3 links for 200s
        ok = 0
        for url in links[:3]:
            s, _, _ = fetch(url, timeout=timeout)
            if 200 <= s < 400:
                ok += 1
        if ok == len(links[:3]) and links:
            score += 3
            r.findings.append("Sampled links resolve cleanly.")
        elif ok > 0:
            score += 1
            r.findings.append(f"{ok}/{len(links[:3])} sampled links resolved.")
        else:
            r.findings.append("Sampled links broken.")
    else:
        r.findings.append("No links found — llms.txt is a curated map; populate it.")

    r.score = min(score, 15)
    if r.score < 15:
        r.fix = "Tighten llms.txt: top-level title, curated link list, no 404s."
        r.fix_impact = 3
        r.fix_effort = 1
    return r


def check_ssr(origin: str, timeout: int) -> CheckResult:
    r = CheckResult(name="Server-side rendering", score=0, max_score=20)
    status, body, _ = fetch(origin, timeout=timeout)
    if status != 200 or not body.strip():
        r.findings.append(f"Homepage did not return 200 ({status}).")
        r.fix = "Make sure the homepage returns 200 to plain GETs without redirect chains."
        r.fix_impact = 5
        r.fix_effort = 3
        return r

    # Strip script/style blocks before counting "real" content.
    no_scripts = re.sub(r"<script[\s\S]*?</script>", "", body, flags=re.IGNORECASE)
    no_styles = re.sub(r"<style[\s\S]*?</style>", "", no_scripts, flags=re.IGNORECASE)
    text_only = re.sub(r"<[^>]+>", " ", no_styles)
    text_only = re.sub(r"\s+", " ", text_only).strip()

    word_count = len(text_only.split())
    has_h1 = bool(re.search(r"<h1[\s>]", body, re.IGNORECASE))
    has_title = bool(re.search(r"<title>[^<]+</title>", body, re.IGNORECASE))
    has_meta_desc = bool(
        re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\'][^"\']{20,}', body, re.IGNORECASE)
    )
    has_og = bool(re.search(r'property=["\']og:title["\']', body, re.IGNORECASE))

    score = 0
    if word_count >= 200:
        score += 8
        r.findings.append(f"~{word_count} visible words in initial HTML.")
    elif word_count >= 60:
        score += 4
        r.findings.append(f"Thin initial HTML (~{word_count} words). Likely JS-rendered.")
    else:
        r.findings.append(f"Almost no content in initial HTML (~{word_count} words). Crawlers will see an empty page.")

    if has_h1:
        score += 4
        r.findings.append("H1 present pre-hydration.")
    else:
        r.findings.append("No H1 in initial HTML.")

    if has_title:
        score += 3
    else:
        r.findings.append("No <title> tag.")

    if has_meta_desc:
        score += 3
    else:
        r.findings.append("Missing meta description.")

    if has_og:
        score += 2

    r.score = min(score, 20)
    if r.score < 16:
        r.fix = "Server-render homepage content. Pre-hydration HTML should contain the H1, intro copy, and primary CTA."
        r.fix_impact = 5
        r.fix_effort = 4
    return r


def check_sitemap(origin: str, timeout: int) -> CheckResult:
    r = CheckResult(name="Sitemap", score=0, max_score=10)

    candidates = ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml"]
    found_url = None
    body = ""
    for path in candidates:
        s, b, _ = fetch(f"{origin}{path}", timeout=timeout)
        if s == 200 and b.strip().startswith("<"):
            found_url = path
            body = b
            break

    if not found_url:
        r.findings.append("No sitemap.xml at common paths.")
        r.fix = "Generate a sitemap.xml and reference it from robots.txt."
        r.fix_impact = 3
        r.fix_effort = 2
        return r

    r.score = 5
    r.findings.append(f"Sitemap at {found_url}.")

    # Try to parse and count URLs
    try:
        root = ET.fromstring(body)
        ns = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
        urls = root.findall(f"{ns}url") + root.findall(f"{ns}sitemap")
        if urls:
            r.score += 3
            r.findings.append(f"Parses cleanly, ~{len(urls)} entries.")
    except ET.ParseError:
        r.findings.append("Sitemap returned but didn't parse as valid XML.")

    # Check robots.txt references the sitemap
    rs, rb, _ = fetch(f"{origin}/robots.txt", timeout=timeout)
    if rs == 200 and "sitemap:" in rb.lower():
        r.score += 2
        r.findings.append("Referenced from robots.txt.")
    else:
        r.findings.append("Not referenced from robots.txt.")
        if not r.fix:
            r.fix = "Add a `Sitemap:` line to robots.txt pointing at sitemap.xml."
            r.fix_impact = 2
            r.fix_effort = 1

    return r


def check_schema(origin: str, timeout: int) -> CheckResult:
    r = CheckResult(name="Schema markup", score=0, max_score=15)
    status, body, _ = fetch(origin, timeout=timeout)
    if status != 200 or not body:
        r.findings.append("Couldn't fetch homepage to inspect schema.")
        return r

    blocks = re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>([\s\S]*?)</script>',
        body,
        re.IGNORECASE,
    )

    if not blocks:
        r.findings.append("No JSON-LD on homepage.")
        r.fix = "Add Organization + WebSite JSON-LD to the homepage; add Article/Product schema to relevant page types."
        r.fix_impact = 4
        r.fix_effort = 2
        return r

    found_types: set[str] = set()
    for raw in blocks:
        try:
            data = json.loads(raw.strip())
        except json.JSONDecodeError:
            continue
        items = data if isinstance(data, list) else [data]
        for item in items:
            if isinstance(item, dict):
                t = item.get("@type")
                if isinstance(t, list):
                    found_types.update(t)
                elif isinstance(t, str):
                    found_types.add(t)
                # @graph nesting
                graph = item.get("@graph")
                if isinstance(graph, list):
                    for sub in graph:
                        if isinstance(sub, dict):
                            st = sub.get("@type")
                            if isinstance(st, list):
                                found_types.update(st)
                            elif isinstance(st, str):
                                found_types.add(st)

    r.findings.append(f"Types present: {', '.join(sorted(found_types)) or 'none parsed'}.")

    score = 3  # has some JSON-LD
    if any(t in found_types for t in ("Organization", "Corporation", "LocalBusiness")):
        score += 5
    else:
        r.findings.append("No Organization schema.")
    if "WebSite" in found_types:
        score += 3
    else:
        r.findings.append("No WebSite schema.")
    if any(t in found_types for t in ("SoftwareApplication", "Product", "Article", "FAQPage", "ItemList")):
        score += 4
    else:
        r.findings.append("No primary content schema (Product / SoftwareApplication / Article / FAQPage).")

    r.score = min(score, 15)
    if r.score < 12 and not r.fix:
        missing = []
        if not any(t in found_types for t in ("Organization", "Corporation", "LocalBusiness")):
            missing.append("Organization")
        if "WebSite" not in found_types:
            missing.append("WebSite")
        if missing:
            r.fix = f"Add JSON-LD to the homepage covering {', '.join(missing)}."
            r.fix_impact = 3
            r.fix_effort = 2
    return r


def check_links(origin: str, timeout: int) -> CheckResult:
    r = CheckResult(name="Crawlable internal links", score=0, max_score=15)
    status, body, _ = fetch(origin, timeout=timeout)
    if status != 200 or not body:
        r.findings.append("Couldn't fetch homepage.")
        return r

    _, host = normalize_domain(origin)
    anchors = re.findall(r'<a\s+([^>]+)>([\s\S]*?)</a>', body, re.IGNORECASE)
    internal: list[tuple[str, str, str]] = []  # (href, anchor_text, rel)

    for attrs, inner in anchors[:120]:
        href_match = re.search(r'href=["\']([^"\']+)["\']', attrs, re.IGNORECASE)
        if not href_match:
            continue
        href = href_match.group(1).strip()
        if href.startswith("#") or href.startswith("mailto:") or href.startswith("tel:"):
            continue
        if href.startswith("/") or host in href:
            rel_match = re.search(r'rel=["\']([^"\']+)["\']', attrs, re.IGNORECASE)
            rel = rel_match.group(1).lower() if rel_match else ""
            text = re.sub(r"<[^>]+>", "", inner)
            text = re.sub(r"\s+", " ", text).strip()
            internal.append((href, text, rel))
        if len(internal) >= 50:
            break

    if not internal:
        r.findings.append("No internal <a> links on homepage. Likely JS-bound navigation.")
        r.fix = "Use real <a href> tags for primary navigation so crawlers can follow."
        r.fix_impact = 5
        r.fix_effort = 3
        return r

    r.findings.append(f"{len(internal)} internal <a> links sampled.")
    score = 8  # baseline for having real anchors

    # Anchor text quality
    weak_anchors = {"click here", "learn more", "read more", "here", "more", ""}
    weak_count = sum(1 for _, t, _ in internal if t.lower() in weak_anchors)
    weak_ratio = weak_count / len(internal)
    if weak_ratio < 0.15:
        score += 4
    elif weak_ratio < 0.35:
        score += 2
        r.findings.append(f"{int(weak_ratio*100)}% of anchors are generic.")
    else:
        r.findings.append(f"{int(weak_ratio*100)}% of anchors are generic — hurts topical signal.")

    # Nofollow ratio
    nofollow_count = sum(1 for _, _, rel in internal if "nofollow" in rel)
    nofollow_ratio = nofollow_count / len(internal)
    if nofollow_ratio < 0.2:
        score += 3
    else:
        r.findings.append(f"{int(nofollow_ratio*100)}% of internal links are nofollow.")
        if not r.fix:
            r.fix = "Strip nofollow from internal links to non-sensitive pages."
            r.fix_impact = 2
            r.fix_effort = 2

    r.score = min(score, 15)
    return r


CHECKS: list[tuple[str, Callable[[str, int], CheckResult]]] = [
    ("Reading robots.txt", check_robots),
    ("Looking for llms.txt", check_llms_txt),
    ("Checking server-side rendering", check_ssr),
    ("Parsing sitemap", check_sitemap),
    ("Inspecting schema markup", check_schema),
    ("Auditing internal links", check_links),
]


# ---------------------------------------------------------------------------
# Streaming output
# ---------------------------------------------------------------------------

def verdict_glyph(v: str) -> str:
    if v == "ok":
        return Color.wrap("✓", Color.GREEN)
    if v == "warn":
        return Color.wrap("~", Color.YELLOW)
    return Color.wrap("✗", Color.RED)


def stream_report(origin: str, host: str, timeout: int) -> list[CheckResult]:
    print()
    print(Color.wrap(f"GEO Audit — {host}", Color.BOLD))
    print(Color.wrap("─" * (12 + len(host)), Color.DIM))
    print()

    results: list[CheckResult] = []
    is_tty = sys.stdout.isatty()
    for label, fn in CHECKS:
        if is_tty:
            sys.stdout.write(f"  {Color.wrap('…', Color.DIM)} {label}")
            sys.stdout.flush()
        start = time.time()
        result = fn(origin, timeout)
        elapsed = time.time() - start
        if is_tty:
            # Carriage return + clear line
            sys.stdout.write("\r\033[K")
        glyph = verdict_glyph(result.verdict)
        score_str = f"{result.score:>3} / {result.max_score}"
        dots = "." * max(2, 36 - len(result.name))
        print(f"  {glyph} {result.name} {Color.wrap(dots, Color.DIM)} {Color.wrap(score_str, Color.BOLD)}  {Color.wrap(f'({elapsed:.1f}s)', Color.DIM)}")
        for finding in result.findings:
            print(f"      {Color.wrap('·', Color.DIM)} {finding}")
        results.append(result)
        print()
    return results


def print_summary(host: str, results: list[CheckResult]):
    total = sum(r.score for r in results)
    max_total = sum(r.max_score for r in results)
    band = (
        "AI-ready" if total >= 85 else
        "Functional but leaking" if total >= 65 else
        "Substantial drag" if total >= 40 else
        "Effectively invisible"
    )

    print(Color.wrap(f"Score: {total} / {max_total}  —  {band}", Color.BOLD))
    print()

    # Rank fixes by (missing_points * impact / effort)
    fix_candidates = [
        (r, (r.max_score - r.score) * (r.fix_impact or 1) / max(r.fix_effort or 1, 1))
        for r in results
        if r.fix
    ]
    fix_candidates.sort(key=lambda x: x[1], reverse=True)

    if fix_candidates:
        print(Color.wrap("Top 3 fixes", Color.BOLD))
        for i, (r, _) in enumerate(fix_candidates[:3], start=1):
            effort_label = "low effort" if r.fix_effort <= 2 else "medium effort" if r.fix_effort == 3 else "higher effort"
            impact_label = "high impact" if r.fix_impact >= 4 else "medium impact" if r.fix_impact >= 3 else "modest impact"
            print(f"  {i}. {r.fix}")
            print(f"     {Color.wrap(f'({impact_label}, {effort_label})', Color.DIM)}")
        print()


# ---------------------------------------------------------------------------
# HTML report
# ---------------------------------------------------------------------------

HTML_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>GEO Audit — {host}</title>
<style>
  :root {{
    --bg: #0b0d10;
    --panel: #14171c;
    --panel-2: #1a1e24;
    --line: #232830;
    --text: #e6e8eb;
    --muted: #8a93a0;
    --accent: #7ee0a9;
    --warn: #f5c265;
    --fail: #f08782;
    --ok: #7ee0a9;
  }}
  * {{ box-sizing: border-box; }}
  html, body {{
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Helvetica Neue", Arial, sans-serif;
    font-feature-settings: "ss01", "cv11";
    -webkit-font-smoothing: antialiased;
  }}
  .wrap {{
    max-width: 880px;
    margin: 0 auto;
    padding: 56px 28px 80px;
  }}
  .eyebrow {{
    color: var(--muted);
    font-size: 13px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 12px;
  }}
  h1.domain {{
    font-size: 36px;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0 0 28px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }}
  .scorecard {{
    display: flex;
    align-items: baseline;
    gap: 18px;
    padding: 28px 28px 24px;
    background: linear-gradient(180deg, var(--panel) 0%, var(--panel-2) 100%);
    border: 1px solid var(--line);
    border-radius: 18px;
    margin-bottom: 28px;
  }}
  .score {{
    font-size: 64px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.02em;
    color: var(--score-color, var(--text));
    font-variant-numeric: tabular-nums;
  }}
  .score .max {{
    color: var(--muted);
    font-size: 22px;
    font-weight: 500;
    margin-left: 4px;
  }}
  .band {{
    font-size: 16px;
    color: var(--muted);
    padding-bottom: 6px;
  }}
  .band b {{ color: var(--text); font-weight: 600; }}
  .section-title {{
    font-size: 13px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 36px 0 14px;
  }}
  table {{
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
    overflow: hidden;
  }}
  th, td {{
    text-align: left;
    padding: 16px 20px;
    border-bottom: 1px solid var(--line);
    font-size: 15px;
    vertical-align: top;
  }}
  th {{
    background: var(--panel-2);
    color: var(--muted);
    font-weight: 500;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }}
  tr:last-child td {{ border-bottom: none; }}
  td.name {{ font-weight: 500; }}
  td.score-cell {{
    width: 150px;
    min-width: 150px;
    color: var(--muted);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }}
  td.score-cell .score-inner {{
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 14px;
    line-height: 1;
  }}
  td.score-cell b {{ color: var(--text); }}
  td.score-cell .glyph {{
    font-size: 18px;
    line-height: 1;
    width: 22px;
    text-align: center;
    flex-shrink: 0;
  }}
  td.score-cell .nums {{
    display: inline-block;
    width: 70px;
    text-align: right;
  }}
  .findings {{
    margin: 6px 0 0;
    padding: 0;
    list-style: none;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.55;
  }}
  .findings li {{ padding-left: 14px; position: relative; }}
  .findings li::before {{
    content: "·";
    position: absolute;
    left: 0;
    color: var(--muted);
  }}
  ol.fixes {{
    list-style: none;
    counter-reset: fix;
    padding: 0;
    margin: 0;
  }}
  ol.fixes li {{
    counter-increment: fix;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 18px 22px 18px 64px;
    margin-bottom: 10px;
    position: relative;
  }}
  ol.fixes li::before {{
    content: counter(fix);
    position: absolute;
    left: 22px;
    top: 18px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: rgba(126, 224, 169, 0.12);
    color: var(--accent);
    font-weight: 600;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }}
  ol.fixes .label {{
    font-size: 15px;
    font-weight: 500;
    color: var(--text);
    margin: 0;
  }}
  ol.fixes .meta {{
    margin-top: 6px;
    font-size: 12px;
    color: var(--muted);
    letter-spacing: 0.02em;
  }}
  .handoff {{
    margin-top: 36px;
    background: linear-gradient(180deg, rgba(126,224,169,0.06) 0%, rgba(126,224,169,0.02) 100%);
    border: 1px solid rgba(126,224,169,0.25);
    border-radius: 16px;
    padding: 22px 24px;
  }}
  .handoff .title {{
    font-size: 14px;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 8px;
  }}
  .handoff p {{
    margin: 0;
    font-size: 15px;
    line-height: 1.55;
    color: var(--text);
  }}
  .handoff code {{
    background: rgba(126,224,169,0.12);
    color: var(--accent);
    padding: 2px 8px;
    border-radius: 6px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 13px;
  }}
  .footer {{
    margin-top: 28px;
    color: var(--muted);
    font-size: 12px;
    text-align: center;
  }}
</style>
</head>
<body>
<div class="wrap">
  <div class="eyebrow">GEO Audit</div>
  <h1 class="domain">{host}</h1>

  <div class="scorecard" style="--score-color: {score_color};">
    <div class="score">{score}<span class="max">/{max_score}</span></div>
    <div class="band"><b>{band_label}</b><br/>{band_desc}</div>
  </div>

  <div class="section-title">What we checked</div>
  <table>
    <thead>
      <tr><th>Check</th><th style="text-align:right;">Score</th></tr>
    </thead>
    <tbody>
      {rows}
    </tbody>
  </table>

  <div class="section-title">What to fix first</div>
  <ol class="fixes">
    {fixes}
  </ol>

  <div class="handoff">
    <div class="title">Next step</div>
    <p>Now that you know what's broken, fix it with content. Load the <code>geo-article-writer</code> skill in Vellum and we'll start filling the topical gaps the audit just surfaced. Tell it your category and your top 2 competitors when it asks.</p>
  </div>

  <div class="footer">geo-audit · run any domain · part of the Vellum GEO toolkit</div>
</div>
</body>
</html>
"""


def _band(score: int, max_score: int) -> tuple[str, str, str]:
    """Return (label, description, css color) for the score band."""
    pct = score / max_score if max_score else 0
    if pct >= 0.85:
        return ("AI-ready", "Content investment will compound. Focus on writing.", "var(--ok)")
    if pct >= 0.65:
        return ("Functional but leaking", "Fix the top 2 issues before scaling content.", "var(--warn)")
    if pct >= 0.40:
        return ("Substantial drag", "The fixes below are urgent.", "var(--warn)")
    return ("Effectively invisible", "Content is wasted spend until infrastructure ships.", "var(--fail)")


def render_html(host: str, results: list[CheckResult]) -> str:
    total = sum(r.score for r in results)
    max_total = sum(r.max_score for r in results)
    band_label, band_desc, score_color = _band(total, max_total)

    glyph_map = {"ok": "✅", "warn": "⚠️", "fail": "❌"}

    row_html = []
    for r in results:
        findings_html = ""
        if r.findings:
            items = "".join(f"<li>{html.escape(f)}</li>" for f in r.findings[:4])
            findings_html = f'<ul class="findings">{items}</ul>'
        row_html.append(
            f"""
            <tr>
              <td class="name">{html.escape(r.name)}{findings_html}</td>
              <td class="score-cell"><div class="score-inner"><span class="glyph">{glyph_map[r.verdict]}</span><span class="nums"><b>{r.score}</b> / {r.max_score}</span></div></td>
            </tr>
            """
        )

    # Sort fixes by (missing × impact / effort)
    fix_candidates = [
        (r, (r.max_score - r.score) * (r.fix_impact or 1) / max(r.fix_effort or 1, 1))
        for r in results
        if r.fix
    ]
    fix_candidates.sort(key=lambda x: x[1], reverse=True)

    fix_html_blocks = []
    for r, _ in fix_candidates[:3]:
        impact_label = "high impact" if r.fix_impact >= 4 else "medium impact" if r.fix_impact >= 3 else "modest impact"
        effort_label = "low effort" if r.fix_effort <= 2 else "medium effort" if r.fix_effort == 3 else "higher effort"
        fix_html_blocks.append(
            f"""
            <li>
              <p class="label">{html.escape(r.fix or '')}</p>
              <div class="meta">{impact_label} · {effort_label}</div>
            </li>
            """
        )

    if not fix_html_blocks:
        fix_html_blocks.append(
            '<li><p class="label">No urgent fixes — site is in good shape. Focus on content.</p></li>'
        )

    return HTML_TEMPLATE.format(
        host=html.escape(host),
        score=total,
        max_score=max_total,
        score_color=score_color,
        band_label=html.escape(band_label),
        band_desc=html.escape(band_desc),
        rows="".join(row_html),
        fixes="".join(fix_html_blocks),
    )


def write_and_open_html(host: str, results: list[CheckResult], no_open: bool = False) -> str:
    html_str = render_html(host, results)
    safe_host = re.sub(r"[^a-zA-Z0-9.-]", "_", host)
    path = os.path.join(tempfile.gettempdir(), f"geo-audit-{safe_host}.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(html_str)
    if not no_open:
        try:
            if sys.platform == "darwin":
                subprocess.run(["open", path], check=False)
            elif sys.platform.startswith("linux"):
                subprocess.run(["xdg-open", path], check=False)
            elif sys.platform.startswith("win"):
                os.startfile(path)  # type: ignore[attr-defined]
        except Exception:
            pass
    return path


# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="One-command technical GEO audit.")
    parser.add_argument("domain", help="Domain or URL to audit (e.g. vellum.ai)")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of streaming markdown")
    parser.add_argument("--no-color", action="store_true", help="Strip ANSI color codes")
    parser.add_argument("--timeout", type=int, default=TIMEOUT_DEFAULT, help="Per-request timeout (seconds)")
    parser.add_argument("--no-html", action="store_true", help="Skip the HTML report (default: write + auto-open in browser)")
    parser.add_argument("--no-open", action="store_true", help="Write the HTML report but don't auto-open it")
    args = parser.parse_args()

    if args.no_color or args.json or not sys.stdout.isatty():
        Color.disable()

    origin, host = normalize_domain(args.domain)

    if args.json:
        results = [fn(origin, args.timeout) for _, fn in CHECKS]
        total = sum(r.score for r in results)
        max_total = sum(r.max_score for r in results)
        out = {
            "domain": host,
            "origin": origin,
            "score": total,
            "max_score": max_total,
            "checks": [asdict(r) for r in results],
        }
        print(json.dumps(out, indent=2))
        return

    results = stream_report(origin, host, args.timeout)
    print_summary(host, results)

    if not args.no_html:
        path = write_and_open_html(host, results, no_open=args.no_open)
        opened_note = "opened in browser" if not args.no_open else "saved (run with default flags to auto-open)"
        print(Color.wrap(f"  Report → {path}  ({opened_note})", Color.DIM))
        print()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n  (interrupted)")
        sys.exit(130)
