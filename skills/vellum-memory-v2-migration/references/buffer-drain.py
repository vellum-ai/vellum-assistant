#!/usr/bin/env python3
"""
Drain /workspace/memory/buffer.md into per-day archives at
/workspace/memory/archive/YYYY-MM-DD.md.

Idempotent: re-running skips entries already present in the destination archive.
Buffer.md is reset to a header-only file ONLY after a clean run with zero
unparsed entries. Unparsed entries are preserved in buffer.md for human review.

Usage:
    python3 buffer-drain.py                 # use current year for date stamps
    python3 buffer-drain.py --year 2026
    python3 buffer-drain.py --dry-run       # report only, no writes

Buffer entry format (canonical):
    - [Mon D, H:MM AM/PM] entry text...
      optional continuation lines

Stdlib only — `yaml` is not available in the sandbox.
"""

import argparse
import calendar
import re
import sys
from datetime import datetime
from pathlib import Path

BUFFER = Path("/workspace/memory/buffer.md")
ARCHIVE_DIR = Path("/workspace/memory/archive")

ENTRY_RE = re.compile(
    r"^- \[(?P<mon>[A-Za-z]+) (?P<day>\d{1,2}),\s+\d{1,2}:\d{2}\s*(?:AM|PM)\]",
    re.IGNORECASE,
)

MONTHS = {}
for i, name in enumerate(calendar.month_name):
    if name:
        MONTHS[name.lower()] = i
for i, name in enumerate(calendar.month_abbr):
    if name:
        MONTHS[name.lower()] = i


def parse_entries(text, default_year):
    """
    Split buffer text into a list of (date_str_or_None, entry_text) tuples.

    A new entry begins at any line matching ENTRY_RE. Subsequent non-matching
    lines belong to the current entry (multi-line bullets). Lines before the
    first match are treated as the file header and ignored.
    """
    out = []
    current_date = None
    current_lines = []

    def flush():
        if current_lines:
            out.append((current_date, "".join(current_lines)))

    for line in text.splitlines(keepends=True):
        m = ENTRY_RE.match(line)
        if m:
            flush()
            mon = MONTHS.get(m.group("mon").lower())
            day = int(m.group("day"))
            if mon is None:
                current_date = None  # will be reported as unparsed
            else:
                current_date = f"{default_year:04d}-{mon:02d}-{day:02d}"
            current_lines = [line]
        else:
            if current_lines:
                current_lines.append(line)
            # else: header line — ignore
    flush()
    return out


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--year",
        type=int,
        default=datetime.now().year,
        help="Year for date stamps (default: current year)",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would happen without writing",
    )
    args = ap.parse_args()

    if not BUFFER.exists():
        print(f"buffer.md not found at {BUFFER}", file=sys.stderr)
        return 1

    text = BUFFER.read_text()
    entries = parse_entries(text, args.year)

    if not entries:
        print("buffer.md has no parseable entries — nothing to drain.")
        return 0

    by_date = {}
    unparsed = []
    for date_str, body in entries:
        if date_str is None:
            unparsed.append(body)
        else:
            by_date.setdefault(date_str, []).append(body)

    parsed_count = sum(len(v) for v in by_date.values())
    print(f"Parsed {parsed_count} entries across {len(by_date)} dates.")
    if unparsed:
        print(
            f"WARNING: {len(unparsed)} entries failed to parse a date. "
            "They will be retained in buffer.md."
        )

    if args.dry_run:
        for date_str in sorted(by_date):
            print(f"  {date_str}: {len(by_date[date_str])} entries")
        if unparsed:
            print(f"  (unparsed): {len(unparsed)} entries")
        return 0

    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    appended = 0
    for date_str in sorted(by_date):
        archive_path = ARCHIVE_DIR / f"{date_str}.md"
        if archive_path.exists():
            existing = archive_path.read_text()
        else:
            existing = f"# {date_str}\n\n"
        if not existing.endswith("\n"):
            existing += "\n"

        new_chunks = []
        for body in by_date[date_str]:
            stripped = body.strip()
            if stripped and stripped in existing:
                # Already archived; idempotent skip.
                continue
            new_chunks.append(body if body.endswith("\n") else body + "\n")

        if new_chunks:
            archive_path.write_text(existing + "".join(new_chunks))
            appended += len(new_chunks)

    print(f"Appended {appended} new entries across {len(by_date)} archive files.")

    if not unparsed:
        ts = datetime.now().isoformat(timespec="seconds")
        BUFFER.write_text(f"# Buffer\n\nDrained at {ts}.\n")
        print(f"buffer.md reset to header-only ({BUFFER}).")
    else:
        BUFFER.write_text("# Buffer\n\n" + "".join(unparsed))
        print(f"buffer.md retained {len(unparsed)} unparsed entries for review.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
