# Log Export — Workspace Allowlist Rules

`POST /v1/export` (handled by `log-export-routes.ts`) builds a tar.gz archive
from audit DB rows, daemon logs under `<workspace>/data/logs/`, and a
sanitized `config.json` snapshot. This directory
(`assistant/src/runtime/routes/log-export/`) houses the allowlist module
that governs which subpaths of the user's workspace directory
(`~/.vellum/workspace/`) are permitted to flow into that archive.

Workspace contents are **opt-in (allowlist), not opt-out**. The workspace
contains arbitrary user files — skills, hooks, routes, conversations,
credentials scaffolding, and other material the user has authored or
installed locally. Accidentally bundling any of that into a support
archive would exfiltrate data the user never intended to share. The
default must therefore be "nothing from the workspace ships" and each
individual entry that _does_ ship must be justified against the rules
below.

## Rule 1 — Prefer time-filterable data

Only allowlist a workspace subpath if its contents can be narrowed to the
`[startTime, endTime]` window carried on the export request.

- When the data is organized as per-record files or per-record
  directories whose **names encode a timestamp**, filter by parsing the
  name. The canonical example is the per-conversation directory layout
  where each directory is named `<ISO-with-dashes>_<conversationId>`
  (the ISO date comes first so ordinary lexicographic comparison yields
  chronological order, and colons in the ISO string are replaced with
  `-` so the name is filesystem-safe). A time filter can be implemented
  by parsing the prefix and comparing it to `startTime` / `endTime`
  without reading file contents.
- When the relevant time information lives **only inside files**, the
  allowlist entry should err on the side of **not** being included —
  unless the file is small, rarely changes, and its full contents are
  acceptable to ship regardless of the requested window.

## Rule 2 — Prefer conversation-filterable data

When the export request carries a `conversationId`, every allowlisted
subpath should narrow itself to that conversation **if at all possible**.

- Data that is intrinsically global (i.e. not associated with a single
  conversation) is acceptable to include **only** when Rule 1 alone is
  sufficient and the request has no `conversationId` filter.
- When a `conversationId` _is_ set and an entry cannot be scoped to it,
  prefer omitting the entry for that particular export rather than
  shipping unrelated conversation data.

The `<ISO-with-dashes>_<conversationId>` directory naming is again the
motivating example: the suffix lets us select exactly one
per-conversation directory without scanning file contents.

## Rule 3 — Default deny

Anything in the workspace that is not explicitly added to the allowlist
module must remain excluded from the export archive. Adding a new entry
requires, in the same PR:

1. Updating the allowlist module in this directory to teach it about the
   new subpath (including its time filter, conversation filter, and
   size cap).
2. Updating this `AGENTS.md` to record the entry name, which filters it
   honors, and its size cap under `## Allowlisted entries`.

Review must confirm both updates landed together. A workspace subpath
that is not mentioned in the registry below is, by definition, not
allowed in the export archive.

## Rule 4 — Bounded size

Every allowlisted entry must enforce a byte cap so that a misbehaving
workspace (e.g. a runaway log, a giant attachment, a pathological skill)
cannot blow up the archive and defeat the export endpoint.

The current convention is **10 MB** across the workspace allowlist,
mirroring `MAX_LOG_PAYLOAD_BYTES` in `log-export-routes.ts`. Entries
should track the number of bytes already consumed and stop adding files
once the cap would be exceeded, preferring to include the newest /
most-relevant records first.

## Allowlisted entries

- _(none yet — first entry will land in a follow-up PR)_
