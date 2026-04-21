# Generic-examples check

Enforces the "Generic Examples" rule from the root `AGENTS.md` — test fixtures,
dialogue examples, and similar illustrative content must use generic
placeholders (Alice, Bob, `user@example.com`, `555-01xx`) rather than real
personal data.

Runs locally from `.githooks/pre-commit` before each commit.

## What it checks

The in-repo patterns detect **shapes** of personal data (email and phone
formats) rather than specific terms. They live in
`scripts/check-generic-examples.ts`:

| Pattern | Severity | What it flags |
|---|---|---|
| `non-example-email` | BLOCK | Emails in string literals not on `example.com` / `example.org` / `example.net` |
| `non-reserved-phone` | WARN | North American phone numbers outside the reserved `555-0100`–`555-0199` range |

## Private patterns (optional, per-developer)

If you want the hook to block additional project-specific terms, drop them into
a **local** config file outside the repo. This keeps sensitive terms off GitHub
while still enforcing them on your machine.

**Location (macOS/Linux, checked in this order):**

1. `$VELLUM_CONTENT_CHECK_PATTERNS` if set
2. `$XDG_CONFIG_HOME/vellum-content-check/patterns.json` if `$XDG_CONFIG_HOME` is set
3. `~/.config/vellum-content-check/patterns.json`

**Format** — an array of objects:

```json
[
  {
    "name": "example-pattern-name",
    "regex": "some-regex-here",
    "flags": "i",
    "severity": "BLOCK",
    "description": "short description for the error message"
  }
]
```

- `name` — short identifier, shown in findings output.
- `regex` — the pattern, as a string. Compiled with the `flags` field.
- `flags` — optional, default `"i"` (case-insensitive).
- `severity` — `"BLOCK"` (default) or `"WARN"`.
- `description` — shown alongside matches to explain why they fired.

Patterns from this file are appended to the shape patterns above.

## Suppression

For legitimate matches — e.g. a test case that needs a real-looking email on
purpose — suppress inline:

```ts
// generic-examples:ignore-next-line — real address needed for DNS-lookup test
const target = "foo@realdomain.com";
```

or on the same line:

```ts
const target = "foo@realdomain.com"; // generic-examples:ignore-line — see above
```

Always include a `— reason:` or equivalent explanation after the directive.
The suppression is intentionally verbose so it shows up in code review.

To bypass the entire hook for one commit: `git commit --no-verify`.

## Usage

```bash
# Scan currently staged changes (what the pre-commit hook calls)
bun scripts/check-generic-examples.ts

# Run the built-in self-tests
bun scripts/check-generic-examples.ts --self-test
```

The script also supports a `--ci` mode that scans the full PR diff (no interactive prompts, warnings fail). It's available if a CI workflow ever wants to call it.

## Files in this directory

- `README.md` — this file
- `patterns.example.json` — an empty template for your local private config
