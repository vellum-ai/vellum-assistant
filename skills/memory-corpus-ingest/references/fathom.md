# Fathom Recording Archives

Fathom is a meeting recorder: it joins calls, records them, transcribes them, and generates AI summaries. A user's Fathom archive is a natural corpus for this skill because it is large, append-only, strongly dated, and queried by date and topic ("what did we decide in the March planning call").

Fathom's export shapes change between plans and product versions, so this reference describes tolerant discovery rather than exact field names. Inventory first, spot-check a few files, and adapt.

## What an export typically contains

Expect some mix of, per meeting:

- **A transcript**, commonly WebVTT (`.vtt`) or plain text. VTT files interleave cue timing lines with the spoken text.
- **An AI summary**, commonly markdown or plain text: bullets, action items, sometimes chapter headings.
- **The recording itself** (video or audio), or only a link back to Fathom's site. Media files can dominate the byte count.
- Sometimes a per-meeting metadata blob (title, date, attendees) as JSON or as a header block inside the summary file.

Discovery moves:

```bash
# shape of the tree and the extension mix
bun run <skill-dir>/scripts/inventory.ts "$VELLUM_WORKSPACE_DIR/imports/fathom"

# spot-check one of each file type before trusting any assumption
find "$VELLUM_WORKSPACE_DIR/imports/fathom" -name '*.vtt' | head -3
```

(`<skill-dir>` is the installed skill directory. The runnable form lives in
SKILL.md Step 3, whose `{baseDir}` placeholder the skill loader substitutes at
load time; substitution does not apply to reference files, so resolve the path
yourself when running from here.)

If the export contains large media files, keep them cold and skim from transcripts and summaries only; the map never needs the audio. If only recordings exist with no transcripts, stop and tell the user: transcription is a separate (and costly) step to decide on explicitly, not something to slip into a skim pass.

## Extracting meeting dates

Try in this order, falling back down the list:

1. **Filenames and directory names.** Exports commonly encode the date in the meeting file or folder name (`2025-03-12 Acme sync.vtt` or similar). The inventory script already recognizes common date patterns in filenames.
2. **Metadata or summary headers.** A date line near the top of the summary or a metadata JSON field.
3. **File mtimes.** Only trustworthy if the export preserved them; a fresh download often stamps everything with the download day. If every mtime is the same day, do not trust mtimes for chronology.

The per-meeting date feeds two things: which slice a meeting belongs to, and the slice page's `origin_date` (the latest meeting date in the slice).

## Extracting speaker names

- **VTT voice tags**: cues like `<v Alice Chen>...</v>` name the speaker inline. Strip the tags for reading; harvest the names for the map.
- **Speaker-prefixed lines**: plain-text transcripts often use `Alice Chen: ...` line prefixes.
- **Summary attendee lists**: AI summaries frequently open with attendees; cheaper to harvest than the transcript.

Speaker names matter to the map at the level of who owns what and who recurs, not per-utterance attribution.

## Recommended slicing

- **Monthly slices** for a dense archive (several meetings a week).
- **Quarterly slices** for a sparser one, or when monthly slicing would push the map past roughly 50 pages.
- One map page per slice, plus the single corpus index page.
- If one month is disproportionately dense (an offsite week, a launch), the inventory script splits oversize buckets into parts; keep those as separate pages rather than writing one giant page.

Per-meeting map pages are almost always wrong: a year of weekly calls would mint hundreds of pages and blow the map budget. The meeting grain lives in the cold store and is reachable through the drill-in skill.

## What belongs in the map page versus the cold store

In the map page (per slice):

- Decisions, with dates and who made them.
- Recurring topics and their arc across the slice (raised, debated, resolved or still open).
- Named people, customers, and projects that recur, and what they own.
- Open threads at the end of the slice.
- Meeting count and the kinds of meetings, so density is visible from the card.

Stays cold (reachable via drill-in, never copied into memory):

- Verbatim transcript text and quotes, except a short quote that is itself the decision.
- Cue timestamps, filler, small talk.
- AI summary text wholesale; the skim distills across meetings, it does not concatenate summaries.

## Drill-in skill notes for Fathom

- Scope searches to the imports directory and offer date filtering by path segment (month directories make `--glob "*2025-03*"` style filters work).
- Search with surrounding context (`rg -C 3`) because VTT timing lines break up sentences; a match without context is often unreadable.
- When a search hits a `.vtt` file, the companion summary file for the same meeting is usually the faster read; teach the skill to name that pairing.
