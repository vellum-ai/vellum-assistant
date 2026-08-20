/**
 * Recognizing the report a watch session ends with, without depending on the
 * model having phrased it the way it phrased it last time.
 *
 * A watch session is the user narrating a task while the assistant reads their
 * screen. When they stop, one turn runs in the session's own conversation and
 * reports what it understood: the task, the phrase the user would ask for it
 * with, the steps, then everything the recording left it guessing about, and
 * finally the alignment pass that asks the user to confirm or correct all of
 * it before a skill is authored. That prompt lives in
 * `assistant/src/watch/watch-retro.ts`.
 *
 * Two of those parts are questions rather than prose. The list of things the
 * assistant could not see is the most correctable thing in the report, and the
 * alignment pass is a question that is waiting for an answer. Both arrive as
 * markdown bullets, which is the shape that reads as hedging. This module
 * finds them so the transcript can draw them as something answerable.
 *
 * **The text is generated, so the shape is a guess and never a contract.** The
 * prompt asks for four things in an order; it does not dictate headings, and
 * the alignment pass is a step in a skill the model narrates in its own words.
 * Three rules follow, and they are the whole design:
 *
 *   1. **Recognition is a conjunction, and failing it is silent.** A report is
 *      only recognized when a section of things-not-known *and* a section
 *      asking for confirmation are both present with points under them. One
 *      alone is an ordinary assistant message that happens to hedge, and
 *      `null` sends the caller back to plain markdown. The fallback is the
 *      rendering every other message gets, never a half-drawn card.
 *
 *   2. **Nothing is dropped.** Every line of the message comes back, either
 *      inside a recognized section or as a verbatim markdown segment in its
 *      original position. A model that adds a fifth section, moves the steps,
 *      or writes a closing paragraph loses none of it: the unrecognized parts
 *      render exactly as they render today, and only the parts that were
 *      understood are redrawn.
 *
 *   3. **Headings are the model's, not ours.** A recognized section carries
 *      the heading the model wrote. Nothing is renamed, so a section whose
 *      wording drifted still reads as the sentence it was written as.
 *
 * Pure: no React, no DOM, so the recognition is testable on strings alone.
 */

/** A run of the message that is rendered as ordinary markdown, verbatim. */
export interface WatchRetroMarkdownSegment {
  readonly kind: "markdown";
  /** The original lines, unmodified and in order. */
  readonly text: string;
}

/**
 * What a recognized section is for.
 *
 * `gaps` is what the recording left the assistant guessing about; `alignment`
 * is what it wants confirmed before it builds anything. They are separate
 * kinds because they are answered differently: a gap has no answer to agree
 * with, an alignment point does.
 */
export type WatchRetroPointsKind = "gaps" | "alignment";

/** A recognized section: the model's heading, its lead-in, and its points. */
export interface WatchRetroPointsSegment {
  readonly kind: WatchRetroPointsKind;
  /** The heading the model wrote, with any list numbering stripped. */
  readonly heading: string;
  /** Prose between the heading and the first point. Markdown, may be empty. */
  readonly lead: string;
  /** One entry per top-level list item, inline markdown preserved. */
  readonly points: readonly string[];
}

export type WatchRetroSegment =
  WatchRetroMarkdownSegment | WatchRetroPointsSegment;

/** An ATX heading, capturing its level and its text without closing hashes. */
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/** The opening or closing line of a fenced code block. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** A top-level list item, bulleted or numbered, capturing its content. */
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/;

/** Leading list numbering on a heading ("4. What I'm unsure about"). */
const HEADING_ORDINAL_RE = /^\d{1,9}[.)]\s*/;

/**
 * Headings that introduce what the recording did not settle.
 *
 * Matched on the vocabulary of not-knowing rather than on any one phrasing,
 * because the prompt asks for "what you are unsure about" and leaves the
 * heading to the model. Deliberately narrow: every word here is one a section
 * about the assistant's own uncertainty uses, and none of them is a word an
 * ordinary report reaches for.
 */
const GAPS_HEADING_RE =
  /\b(?:unsure|uncertain|uncertainties|uncertainty|unclear|unknowns?|guess(?:es|ed|ing)?|assum(?:e|ed|ing|ption|ptions)|not sure|open questions?|(?:do|did|could|can|would)(?:\s?n'?t|\s+not)\s+(?:know|see|tell|read|make out))\b/;

/**
 * Headings that introduce the request for confirmation.
 *
 * The alignment pass is the first step of the `skill-management` skill, which
 * describes it as aligning with the user before building, so "align" and
 * "confirm" are the two words it reliably reaches for.
 */
const ALIGNMENT_HEADING_RE =
  /\b(?:align|aligned|aligning|alignment|confirm|confirms|confirmed|confirmation)\b/;

/** One heading and the lines beneath it, before the next heading. */
interface Section {
  /** The heading line as written, or `null` for text before any heading. */
  readonly headingLine: string | null;
  readonly headingText: string;
  readonly body: readonly string[];
}

/**
 * Split `markdown` at every ATX heading.
 *
 * Fenced code is tracked so a `#` comment inside a shell block never opens a
 * section, which would otherwise let a report that quotes a script split in
 * the middle of it.
 */
function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let headingLine: string | null = null;
  let headingText = "";
  let body: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (headingLine !== null || body.some((line) => line.trim().length > 0)) {
      sections.push({ headingLine, headingText, body });
    }
  };

  for (const line of markdown.split("\n")) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      if (fence === null) {
        fence = marker[0] ?? null;
      } else if (marker[0] === fence) {
        fence = null;
      }
      body.push(line);
      continue;
    }
    const heading = fence === null ? HEADING_RE.exec(line) : null;
    if (heading) {
      flush();
      headingLine = line;
      headingText = (heading[2] ?? "").trim();
      body = [];
      continue;
    }
    body.push(line);
  }
  flush();

  return sections;
}

/** A heading reduced to the words it is classified on. */
function normalizeHeading(headingText: string): string {
  return headingText
    .replace(HEADING_ORDINAL_RE, "")
    .replace(/[*_`~]/g, "")
    .toLowerCase();
}

/** The heading a recognized section shows: the model's, minus its numbering. */
function displayHeading(headingText: string): string {
  return headingText.replace(HEADING_ORDINAL_RE, "").trim();
}

/** A section's body split into its lead prose, its points, and what follows. */
interface BodyParts {
  readonly lead: string;
  readonly points: string[];
  readonly trailing: string;
}

/**
 * Read a section's body as lead-in prose, a list, and whatever came after it.
 *
 * A point is a top-level list item; lines indented under one are folded into
 * it, so a bullet that wraps onto a continuation line stays one point. The
 * first unindented non-list line after the list ends it, and everything from
 * there is trailing prose the caller re-emits as markdown. This is what keeps
 * rule 2 true for a section that closes with a sentence.
 */
function splitBody(body: readonly string[]): BodyParts {
  const lead: string[] = [];
  const points: string[] = [];
  const trailing: string[] = [];
  let phase: "lead" | "list" | "trailing" = "lead";
  let fence: string | null = null;

  for (const line of body) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      if (fence === null) {
        fence = marker[0] ?? null;
      } else if (marker[0] === fence) {
        fence = null;
      }
    }
    const item = fence === null ? LIST_ITEM_RE.exec(line) : null;
    if (item && phase !== "trailing") {
      points.push((item[1] ?? "").trim());
      phase = "list";
      continue;
    }
    if (phase === "lead") {
      lead.push(line);
      continue;
    }
    if (phase === "list") {
      if (line.trim().length === 0) {
        continue;
      }
      // Indented under the item above, so it belongs to that point rather
      // than ending the list.
      if (/^[ \t]/.test(line) && points.length > 0) {
        points[points.length - 1] =
          `${points[points.length - 1]} ${line.trim()}`.trim();
        continue;
      }
      phase = "trailing";
    }
    trailing.push(line);
  }

  return {
    lead: trimBlankEdges(lead).join("\n"),
    points,
    trailing: trimBlankEdges(trailing).join("\n"),
  };
}

/** Drop blank lines from both ends, leaving the interior alone. */
function trimBlankEdges(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim().length === 0) {
    start += 1;
  }
  while (end > start && (lines[end - 1] ?? "").trim().length === 0) {
    end -= 1;
  }
  return lines.slice(start, end);
}

/** Append `text` to the run of markdown being accumulated, if it has content. */
function pushMarkdown(out: WatchRetroSegment[], text: string): void {
  if (text.trim().length === 0) {
    return;
  }
  const last = out[out.length - 1];
  if (last && last.kind === "markdown") {
    out[out.length - 1] = { kind: "markdown", text: `${last.text}\n${text}` };
    return;
  }
  out.push({ kind: "markdown", text });
}

/**
 * Read `markdown` as a watch retrospective, or return `null`.
 *
 * `null` is the ordinary outcome for every message that is not one, and the
 * caller's answer to it is the plain markdown rendering. See the module
 * docstring for why recognition is a conjunction and why nothing is dropped.
 */
export function parseWatchRetro(
  markdown: string,
): readonly WatchRetroSegment[] | null {
  const sections = splitSections(markdown);
  const segments: WatchRetroSegment[] = [];
  const claimed = new Set<WatchRetroPointsKind>();

  for (const section of sections) {
    const kind = classify(section, claimed);
    if (kind === null) {
      pushMarkdown(
        segments,
        [section.headingLine, ...section.body]
          .filter((line): line is string => line !== null)
          .join("\n"),
      );
      continue;
    }
    claimed.add(kind);
    const { lead, points, trailing } = splitBody(section.body);
    segments.push({
      kind,
      heading: displayHeading(section.headingText),
      lead,
      points,
    });
    pushMarkdown(segments, trailing);
  }

  if (!claimed.has("gaps") || !claimed.has("alignment")) {
    return null;
  }
  return segments;
}

/**
 * What `section` is, given what has already been claimed.
 *
 * Each kind is claimed once, by the first section that matches it and carries
 * points. A later section matching the same vocabulary is left as markdown
 * rather than drawn as a second panel of the same kind, so a report that
 * revisits its own uncertainties reads as one place to answer them.
 */
function classify(
  section: Section,
  claimed: ReadonlySet<WatchRetroPointsKind>,
): WatchRetroPointsKind | null {
  if (section.headingLine === null) {
    return null;
  }
  const heading = normalizeHeading(section.headingText);
  let kind: WatchRetroPointsKind;
  if (!claimed.has("gaps") && GAPS_HEADING_RE.test(heading)) {
    kind = "gaps";
  } else if (!claimed.has("alignment") && ALIGNMENT_HEADING_RE.test(heading)) {
    kind = "alignment";
  } else {
    return null;
  }
  // A heading with nothing listed under it is a heading, not a set of things
  // to answer. Leaving it unclaimed lets a later section carry the kind.
  return splitBody(section.body).points.length > 0 ? kind : null;
}
