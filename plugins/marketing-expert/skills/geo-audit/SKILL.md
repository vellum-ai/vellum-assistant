---
name: geo-audit
description: Runs a one-command technical GEO audit on any domain. Checks AI crawler access, llms.txt presence, server-side rendering, sitemap, and schema markup. Streams results live and ends with a 0–100 score plus the top 3 prioritized fixes. Built to be both genuinely useful and great to demo on camera.
metadata:
  emoji: "🔎"
  vellum:
    display-name: "GEO Audit"
    category: "development"
    activation-hints:
      - "Run a GEO audit on <url>"
      - "Do a GEO audit check on my domain: <url>"
      - "GEO audit <url> / Audit <url> for GEO"
      - "Check how AI-ready / crawlable my site is"
      - "Why isn't my site getting picked up by ChatGPT / Perplexity / Gemini?"
    avoid-when:
      - "User wants to write an article, comparison page, or topical hub — route to geo-article-writer"
      - "User wants GEO measurement, strategy, or cadence advice rather than a technical site scan — route to geo-operator"
---

# GEO Audit

A fast, real technical audit of how AI-ready a website is. Type a domain, get a streaming scorecard back in under 30 seconds, ending with the three things most worth fixing.

This is the operator-side companion to writing content. It tells you whether your site is even _legible_ to AI agents before you spend a quarter producing for them.

---

## TRIGGER

Fire this skill **immediately** — no clarifying questions, no preamble — when the user says any of the following (or close variants):

- "Do a GEO audit check on my domain: <url>"
- "Run a GEO audit on <url>"
- "GEO audit <url>"
- "Audit <url> for GEO"

Extract the domain from the message and run the script. Stream the terminal output back as it happens. When the HTML report opens, mention that it just popped up in their browser and summarize the score in one sentence.

## WHEN TO USE THIS SKILL

Use this when someone wants to:

- Quickly understand how AI-friendly a site is
- Diagnose why a site they've written for isn't getting picked up by ChatGPT, Perplexity, Gemini, or Claude
- Produce a demo-able audit on any domain on the fly
- Triage technical GEO issues before kicking off a content program

Do **not** use this skill for writing articles, comparison pages, or topical hubs. Route those to `geo-article-writer`.

---

## USAGE

```bash
python3 {baseDir}/scripts/audit.py <domain>
```

Examples:

```bash
python3 {baseDir}/scripts/audit.py vellum.ai
python3 {baseDir}/scripts/audit.py https://stripe.com
python3 {baseDir}/scripts/audit.py example.com --json
```

The script accepts a bare domain (`vellum.ai`), a full URL (`https://vellum.ai`), or anything in between. It normalizes.

**If the script runs cleanly → stream the output and summarize (default).**
**If the domain is unreachable / DNS fails / times out →** report the specific failure plainly, suggest the user double-check the domain or bump `--timeout`, and do not invent a score.
**If `python3` is unavailable or blocked in this session →** say so directly. Do not fabricate a scorecard or paraphrase what the audit "would" find — the numbers only exist if the script ran.

Flags:

- `--json` — emit the report as JSON instead of streaming markdown (for piping into other tools)
- `--no-color` — strip ANSI color codes (for logs / CI)
- `--no-html` — skip the HTML report (default: writes one to a temp file and auto-opens it in your browser)
- `--no-open` — write the HTML report but don't auto-open it
- `--timeout N` — per-request timeout in seconds (default: 10)

By default the script does two things at once: streams a clean terminal scorecard live as checks complete, **and** opens a dark-themed HTML report in your browser at the end with a table, prioritized fixes, and a handoff to `geo-article-writer`. The terminal version is the watchable moment; the HTML is the keepable artifact.

---

## WHAT IT CHECKS

Six checks, each scored. Total: 100 points.

### 1. AI crawler access via `robots.txt` (25 pts)

Pulls `/robots.txt` and verifies each of the major AI agents is either explicitly allowed or not actively blocked:

- `GPTBot`, `ChatGPT-User`, `OAI-SearchBot` (OpenAI)
- `ClaudeBot`, `anthropic-ai` (Anthropic)
- `PerplexityBot`, `Perplexity-User` (Perplexity)
- `Google-Extended` (Gemini / Google AI Overviews — separate from `Googlebot`)
- `CCBot` (Common Crawl, feeds many training sets)

A site that blocks `Google-Extended` is invisible to Gemini and AI Overviews even if it ranks fine in regular Google. This is the most common silent miss.

### 2. `llms.txt` presence and shape (15 pts)

Looks for `/llms.txt` at the domain root. Scores on:

- Exists
- Has a top-level `#` title
- Lists at least one curated link
- Links resolve (no 404s on the first batch)

`llms.txt` is the emerging convention for handing AI crawlers a curated map. It's still optional, but it's a cheap differentiator.

### 3. Server-side rendering (20 pts)

Fetches the homepage _without_ executing JS and checks whether the brand name, primary H1, and primary CTA are present in the initial HTML.

This is the single most under-detected GEO failure. A JS-rendered marketing site can look fine to a human and be completely empty to GPTBot, which generally does not execute JavaScript.

### 4. `sitemap.xml` (10 pts)

Confirms a sitemap exists, is referenced from `robots.txt`, parses as valid XML, and contains a reasonable URL count.

### 5. Schema markup on homepage (15 pts)

Parses inline JSON-LD on the homepage and scores presence of:

- `Organization` (brand identity for AI)
- `WebSite` with `SearchAction` (helps Google understand site search)
- A primary content schema (`Product`, `SoftwareApplication`, or `Article` — whichever fits)

Schema is one of the few signals models read directly without inference. It punches above its weight.

### 6. Crawlable internal links (15 pts)

Fetches the homepage and inspects the first 50 internal `<a>` tags for:

- Actual `href` values (not JS-bound `<div onclick>` substitutes)
- Descriptive anchor text (not "click here," "learn more," empty)
- No-follow ratio under 20%

If your important pages are reachable only through JS-bound elements, they're invisible to most crawlers.

---

## OUTPUT

The script streams a markdown scorecard as checks complete. Each check is one line until done, then resolves to a verdict line. At the end:

```
GEO Audit — {domain}

✓ AI crawler access ............... 22 / 25
✗ llms.txt ........................  3 / 15
✓ Server-side rendering ........... 20 / 20
✓ Sitemap .........................  9 / 10
~ Schema markup ...................  8 / 15
✓ Crawlable internal links ........ 13 / 15

Score: 75 / 100

Top 3 fixes
  1. Stand up an llms.txt at the domain root (high impact, low effort)
  2. Add Organization + SoftwareApplication JSON-LD to the homepage
  3. Unblock CCBot in robots.txt (cheap win for training-set coverage)
```

The "top 3 fixes" are not just the lowest-scored checks — they're sorted by `(points missing × impact weight) / effort estimate` so the user gets a real prioritized list.

---

## INTERPRETING THE SCORE

- **85–100** — AI-ready. Content investment will compound. Focus on writing.
- **65–84** — Functional but leaking. Fix the top 2 issues before scaling content.
- **40–64** — Substantial drag. The audit's top 3 fixes are urgent.
- **0–39** — The site is effectively invisible to most AI crawlers. Content is wasted spend until infrastructure ships.

---

## DEFAULT DELIVERABLE

When asked to audit a site, run the script and return the streamed report verbatim. Then add one paragraph of plain-language context: what the score means for this specific site, and which of the top 3 fixes is most worth shipping this week.

> ⚠️ CRITICAL — at the moment you return the report: do not silently rewrite, round, or "clean up" the report's verdicts. The numbers are the product. If the script didn't run, there is no score — say that, never estimate one.

## SKILL COMPLETE WHEN

- [ ] `audit.py` ran against the requested domain and exited without error
- [ ] The streamed scorecard (six checks + total + top 3 fixes) was returned to the user verbatim
- [ ] One paragraph of plain-language context named which fix to ship first
- [ ] If the HTML report was generated, the user was told it opened in their browser
