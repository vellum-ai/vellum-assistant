#!/usr/bin/env bash
set -euo pipefail

# FlexFrame guardrail script
#
# Detects `.frame(maxWidth:)` / `.frame(maxHeight:)` / `.frame(minWidth:)` /
# `.frame(minHeight:)` / `.frame(idealWidth:)` / `.frame(idealHeight:)` usages
# in performance-sensitive chat/window directories.
# These modifiers create `_FlexFrameLayout`, which queries `explicitAlignment`
# on descendants — cascading O(depth × children) per layout pass and causing
# multi-second hangs in LazyVStack-backed hierarchies.
#
# ALL parameters on the flexible frame overload — minWidth, minHeight, maxWidth,
# maxHeight, idealWidth, idealHeight — create `_FlexFrameLayout`. The fixed
# overload (width:, height:)
# creates `_FrameLayout` instead. See:
# https://developer.apple.com/documentation/swiftui/view/frame(minwidth:idealwidth:maxwidth:minheight:idealheight:maxheight:alignment:)
#
# See clients/macos/AGENTS.md (section "No `_FlexFrameLayout` ... in LazyVStack/
# LazyHStack/LazyVGrid cell hierarchy") for the rule and safe alternatives.
#
# Safe alternatives:
#   - .widthCap(N)                         — O(1) width cap via WidthCapLayout
#   - .fixedWidth(N)                       — O(1) fixed width via FixedWidthLayout
#   - .topAlignedMinHeight(N)              — O(1) min-height with top alignment
#   - .bottomAlignedMinHeight(N)           — O(1) min-height with bottom alignment
#   - .frame(width: N) / .frame(height: N) — _FrameLayout (but not safe as cascade barrier)
#   - HStack { content; Spacer(minLength: 0) } / Spacer + content — alignment without FlexFrame
#
# Historical context: this cascade has been fixed 9+ times in chat-surface code
# (PRs #24019, #24091, #24584, #24589, #25844, #25947, #26007, #26053, #26092, #26220).
# The manual audit process missed regressions twice — this lint enforces the rule
# mechanically. Tracked in LUM-1116.
#
# Usage: check-flexframe.sh [--update-baseline]
#
# Baseline (allowlist) format — `clients/scripts/flexframe-allowlist.txt`:
#   <path>|<trimmed-line-content>
# One entry per occurrence (multiplicity-preserving). Line numbers are intentionally
# NOT part of the key so the allowlist survives unrelated line drift.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CLIENTS_DIR/.." && pwd)"
ALLOWLIST_FILE="$SCRIPT_DIR/flexframe-allowlist.txt"

UPDATE_BASELINE=0
for arg in "$@"; do
  case "$arg" in
    --update-baseline) UPDATE_BASELINE=1 ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# Scope: performance-sensitive chat + main window feature directories.
# Conservative by design; expand in a follow-up if this proves valuable.
SCAN_DIRS=(
  "clients/macos/vellum-assistant/Features/Chat/"
  "clients/macos/vellum-assistant/Features/Home/"
  "clients/macos/vellum-assistant/Features/MainWindow/"
)

# Matches .frame(maxWidth: ...) / .frame(maxHeight: ...) / .frame(minWidth: ...)
# / .frame(minHeight: ...) / .frame(idealWidth: ...) / .frame(idealHeight: ...)
# — any value. ALL six parameters live on the flexible frame overload and
# create `_FlexFrameLayout`.
# Rust-regex compatible (no lookaround) so it works with ripgrep's default
# engine; we strip comment-only lines in a second pass below.
PATTERN='\.frame\(\s*(max|min|ideal)(Width|Height)\s*:'

cd "$REPO_ROOT"

collect_raw_hits() {
  if command -v rg >/dev/null 2>&1; then
    rg -U --multiline-dotall -n --no-heading "$PATTERN" "${SCAN_DIRS[@]}" 2>/dev/null
    return
  fi

  if ! command -v perl >/dev/null 2>&1; then
    echo "ERROR: flexframe lint requires either ripgrep (rg) or perl in PATH." >&2
    exit 2
  fi

  find "${SCAN_DIRS[@]}" -type f -name '*.swift' -print0 2>/dev/null \
    | perl -0ne '
        chomp;
        my $file = $_;
        open my $fh, "<", $file or next;
        local $/;
        my $content = <$fh>;
        close $fh;

        my @lines = split /\n/, $content, -1;
        my %printed;
        while ($content =~ /\.frame\(\s*(?:(?:max|min|ideal)(?:Width|Height))\s*:/sg) {
          my $start_line = substr($content, 0, $-[0]) =~ tr/\n//;
          my $end_line = substr($content, 0, $+[0]) =~ tr/\n//;
          for my $idx ($start_line .. $end_line) {
            next if $idx > $#lines;
            my $line_no = $idx + 1;
            my $line = $lines[$idx];
            my $key = "$line_no:$line";
            next if $printed{$key}++;
            print "$file:$line_no:$line\n";
          }
        }
      '
}

# Collect raw hits with line numbers, then drop comment-only lines
# (lines whose first non-whitespace is `//` or `///`). AGENTS.md-style
# warnings like `// ⚠️ No .frame(maxWidth:) in LazyVStack cells` would
# otherwise false-positive.
#
# `-U --multiline-dotall` enables multiline matching so `.frame(` wrapped
# across lines (opening paren on one line, `maxWidth:` on the next) is
# caught. Without this, code formatted as `.frame(\n    maxWidth: …\n)`
# bypasses the lint silently — a real escape already present at
# ChatLoadingSkeleton.swift before this PR. The fallback scanner mirrors
# ripgrep's line-oriented output for multiline matches so the allowlist remains
# stable when CI hosts do not have `rg` preinstalled.
RAW_HITS=$(collect_raw_hits \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*//' \
  || true)

# Build the comparison set: `<path>|<trimmed-content>` (no line number, whitespace stripped).
# Preserves multiplicity via plain `sort` (not `sort -u`).
normalize() {
  # Input:  clients/.../Foo.swift:42:        .frame(maxWidth: .infinity)
  # Output: clients/.../Foo.swift|.frame(maxWidth: .infinity)
  sed -E 's/^([^:]+):[0-9]+:[[:space:]]*/\1|/'
}

OBSERVED_NORMALIZED=""
if [[ -n "$RAW_HITS" ]]; then
  OBSERVED_NORMALIZED=$(printf '%s\n' "$RAW_HITS" | normalize | sort)
fi

# --update-baseline: rewrite the allowlist to match the current observed set.
# Use sparingly; every entry is a TODO to eventually convert to a safe alternative.
if [[ "$UPDATE_BASELINE" == "1" ]]; then
  {
    cat <<'HEADER'
# FlexFrame allowlist — intentional `.frame(max/minWidth:)` / `.frame(max/minHeight:)` usages.
#
# Each line is `<path>|<trimmed-line-content>` for one occurrence. Line numbers
# are intentionally omitted so entries survive unrelated line drift.
#
# Why an entry is here (typical reasons):
#   - Leaf view (Text / Image / VIconView) where `_FlexFrameLayout`'s cascade
#     bottoms out immediately — cost is O(0), so the alignment-query concern
#     is purely theoretical. (e.g. `.frame(maxWidth: .infinity, alignment: .leading)`
#     wrapping a single `Text` with `.lineLimit(1).truncationMode(.tail)` — a
#     configuration that `HStack + Spacer` breaks.)
#   - Top-level container outside any Lazy* hierarchy where an explicit
#     fill-parent semantic is load-bearing.
#   - Sheet / modal / detail panel surfaces rendered eagerly (no lazy container
#     and no animated transition in the parent).
#
# Adding a new entry: BEFORE allowlisting, first try a safe alternative:
#   .widthCap(N), .fixedWidth(N), .topAlignedMinHeight(N),
#   .bottomAlignedMinHeight(N), HStack+Spacer.
# If and only if none of those preserve required semantics (truncation, exact
# alignment, fill-parent for a modal root), add the entry and a one-line note
# in the PR description explaining why. The default answer is "use a safe
# alternative"; this file is a last resort, not a general escape hatch.
#
# Regenerate this file after an intentional bulk refactor with:
#   bash clients/scripts/check-flexframe.sh --update-baseline
#
# See clients/macos/AGENTS.md §§ "No `_FlexFrameLayout` ... in LazyVStack/
# LazyHStack/LazyVGrid cell hierarchy" for the underlying rule.
HEADER
    if [[ -n "$OBSERVED_NORMALIZED" ]]; then
      printf '%s\n' "$OBSERVED_NORMALIZED"
    fi
  } > "$ALLOWLIST_FILE"
  COUNT=$(printf '%s\n' "$OBSERVED_NORMALIZED" | grep -cE '.' || true)
  echo "Wrote $COUNT allowlist entries to $ALLOWLIST_FILE"
  exit 0
fi

# Load the allowlist (strip comments + blank lines), preserving multiplicity.
#
# `grep -v` exits 1 when no lines match — under `set -euo pipefail` that
# would abort the script if the allowlist is ever header-only (e.g. after
# a full cleanup or `--update-baseline` with zero observed violations).
# `|| true` tolerates that edge case so a clean state stays clean.
ALLOWLIST_ENTRIES=""
if [[ -f "$ALLOWLIST_FILE" ]]; then
  ALLOWLIST_RAW=$(grep -vE '^([[:space:]]*#|[[:space:]]*$)' "$ALLOWLIST_FILE" || true)
  if [[ -n "$ALLOWLIST_RAW" ]]; then
    ALLOWLIST_ENTRIES=$(printf '%s\n' "$ALLOWLIST_RAW" | sort)
  fi
fi

# New violations = observed - allowlist (multiset difference preserved by `comm -23`).
NEW_NORMALIZED=""
if [[ -n "$OBSERVED_NORMALIZED" ]]; then
  NEW_NORMALIZED=$(comm -23 \
    <(printf '%s\n' "$OBSERVED_NORMALIZED") \
    <(printf '%s\n' "$ALLOWLIST_ENTRIES"))
fi

# Stale allowlist entries = allowlist - observed. Warn (don't fail) so the
# allowlist shrinks as code is cleaned up.
STALE_NORMALIZED=""
if [[ -n "$ALLOWLIST_ENTRIES" ]]; then
  STALE_NORMALIZED=$(comm -13 \
    <(printf '%s\n' "${OBSERVED_NORMALIZED:-}") \
    <(printf '%s\n' "$ALLOWLIST_ENTRIES"))
fi

# Count non-blank lines. `grep -c` handles trailing-newline edge cases correctly
# (unlike `printf '%s' | wc -l` which undercounts by 1 when there's no final \n).
count_nonblank() {
  if [[ -z "${1:-}" ]]; then echo 0; return; fi
  printf '%s\n' "$1" | grep -cE '.'
}

NEW_COUNT=$(count_nonblank "${NEW_NORMALIZED:-}")
STALE_COUNT=$(count_nonblank "${STALE_NORMALIZED:-}")

# Map each new normalized violation back to the raw `file:line:content` hits
# for a useful diagnostic. A given `<path>|<content>` may map to multiple
# raw lines; we want exactly `new_count[key]` of them printed per key.
#
# Implemented with two temp files to stay compatible with bash 3.2 (macOS
# default — no associative arrays).
print_new_violations() {
  local budget_file sorted_budget_file
  budget_file=$(mktemp)
  sorted_budget_file=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '$budget_file' '$sorted_budget_file'" RETURN

  # Build a "budget" of how many instances of each normalized key are NEW.
  printf '%s\n' "$NEW_NORMALIZED" \
    | grep -vE '^$' \
    | sort \
    | uniq -c \
    | sed -E 's/^[[:space:]]*([0-9]+)[[:space:]]+/\1\t/' \
    > "$sorted_budget_file" || true

  # Walk raw hits in source order; for each raw line, look up its normalized
  # key's remaining budget and emit if > 0, decrementing as we go.
  while IFS= read -r raw; do
    [[ -z "$raw" ]] && continue
    normalized=$(printf '%s\n' "$raw" | normalize)
    # Lookup current remaining budget for this key.
    remaining=$(awk -F'\t' -v k="$normalized" '$2 == k { print $1; exit }' "$sorted_budget_file")
    if [[ -n "$remaining" && "$remaining" -gt 0 ]]; then
      echo "  $raw"
      # Decrement.
      awk -F'\t' -v k="$normalized" 'BEGIN{OFS=FS}
        $2 == k { $1 = $1 - 1 }
        { print }
      ' "$sorted_budget_file" > "$budget_file"
      mv "$budget_file" "$sorted_budget_file"
    fi
  done <<< "$RAW_HITS"
}

if [[ "$NEW_COUNT" -gt 0 ]]; then
  echo "=== flexframe lint: $NEW_COUNT new violation(s) ==="
  echo
  echo "  .frame(max/min/idealWidth:) / .frame(max/min/idealHeight:)"
  echo "  create _FlexFrameLayout, which queries explicitAlignment on descendants and"
  echo "  cascades O(depth × children) per layout pass. This causes multi-second hangs"
  echo "  in LazyVStack-backed chat hierarchies."
  echo
  echo "  Safe alternatives (see clients/macos/AGENTS.md §§ 'No _FlexFrameLayout ...'):"
  echo "    .widthCap(N)                              — O(1) width cap"
  echo "    .fixedWidth(N)                            — O(1) fixed width"
  echo "    .topAlignedMinHeight(N)                   — O(1) min-height, top-aligned"
  echo "    .bottomAlignedMinHeight(N)                — O(1) min-height, bottom-aligned"
  echo "    HStack { content; Spacer(minLength: 0) }  — leading alignment, no FlexFrame"
  echo "    HStack { Spacer(minLength: 0); content }  — trailing alignment, no FlexFrame"
  echo
  echo "  If none of the above preserve the required semantics (e.g. single-line Text"
  echo "  truncation, modal-root fill-parent), add an entry to:"
  echo "    clients/scripts/flexframe-allowlist.txt"
  echo "  and explain why in your PR description."
  echo
  echo "  New violation(s):"
  print_new_violations
  echo
  if [[ "$STALE_COUNT" -gt 0 ]]; then
    echo "  Note: $STALE_COUNT allowlist entry/entries no longer match any code"
    echo "  (likely from prior cleanup). Run to tidy:"
    echo "    bash clients/scripts/check-flexframe.sh --update-baseline"
  fi
  exit 1
fi

OBSERVED_COUNT=$(count_nonblank "${OBSERVED_NORMALIZED:-}")
echo "flexframe lint: OK ($OBSERVED_COUNT allowlisted, 0 new)"
if [[ "$STALE_COUNT" -gt 0 ]]; then
  echo "  Note: $STALE_COUNT stale allowlist entry/entries — run with --update-baseline to prune."
fi
exit 0
