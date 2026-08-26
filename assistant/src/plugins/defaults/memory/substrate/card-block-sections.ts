import { INJECTED_CONCEPT_HEADER_REGEX } from "./injected-block-slugs.js";

const CARD_HEADER_REGEX =
  /^# (?:memory\/concepts\/.+\.md|Skill: .+|CLI command: .+)$/gm;
const CARD_FRAME_PREFIX = "<!-- vellum-memory-card:";
const CARD_FRAME_SUFFIX = " -->\n";

export interface CardSection {
  slug: string;
  text: string;
}

export type CardBlockPiece =
  | { kind: "card"; slug: string; text: string }
  | { kind: "other"; text: string };

export function frameCardSection(text: string): string {
  return `${CARD_FRAME_PREFIX}${text.length}${CARD_FRAME_SUFFIX}${text}`;
}

export function renderCardSections(
  preamble: string,
  pieces: readonly CardBlockPiece[],
  framed: boolean,
): string {
  const renderedPieces = pieces.map((piece) =>
    framed ? frameCardSection(piece.text) : piece.text,
  );
  return [preamble, ...renderedPieces]
    .filter((piece) => piece.length > 0)
    .join("\n\n");
}

function cardBlockPiece(text: string): CardBlockPiece {
  const slug = text.startsWith("# memory/concepts/")
    ? [...text.matchAll(INJECTED_CONCEPT_HEADER_REGEX)][0]?.[1]
    : undefined;
  return slug ? { kind: "card", slug, text } : { kind: "other", text };
}

function parseFramedCardSections(inner: string): {
  preamble: string;
  pieces: CardBlockPiece[];
} | null {
  const firstFrame = inner.indexOf(CARD_FRAME_PREFIX);
  if (firstFrame < 0) {
    return null;
  }
  if (
    firstFrame > 0 &&
    (firstFrame < 2 ||
      inner[firstFrame - 1] !== "\n" ||
      inner[firstFrame - 2] !== "\n")
  ) {
    return null;
  }

  const pieces: CardBlockPiece[] = [];
  let cursor = firstFrame;
  while (cursor < inner.length) {
    if (!inner.startsWith(CARD_FRAME_PREFIX, cursor)) {
      return null;
    }
    const lengthStart = cursor + CARD_FRAME_PREFIX.length;
    const lengthEnd = inner.indexOf(CARD_FRAME_SUFFIX, lengthStart);
    if (lengthEnd < 0) {
      return null;
    }
    const rawLength = inner.slice(lengthStart, lengthEnd);
    if (!/^\d+$/.test(rawLength)) {
      return null;
    }
    const contentStart = lengthEnd + CARD_FRAME_SUFFIX.length;
    const contentEnd = contentStart + Number(rawLength);
    if (contentEnd > inner.length) {
      return null;
    }
    pieces.push(cardBlockPiece(inner.slice(contentStart, contentEnd)));
    if (contentEnd === inner.length) {
      break;
    }
    if (inner.slice(contentEnd, contentEnd + 2) !== "\n\n") {
      return null;
    }
    cursor = contentEnd + 2;
  }
  return { preamble: inner.slice(0, firstFrame).trimEnd(), pieces };
}

export function parseCardSections(inner: string): {
  preamble: string;
  sections: CardSection[];
  pieces: CardBlockPiece[];
  framed: boolean;
} {
  const framed = parseFramedCardSections(inner);
  if (framed) {
    const sections = framed.pieces.filter(
      (piece): piece is Extract<CardBlockPiece, { kind: "card" }> =>
        piece.kind === "card",
    );
    return { ...framed, sections, framed: true };
  }
  const conceptSlugsByIndex = new Map(
    [...inner.matchAll(INJECTED_CONCEPT_HEADER_REGEX)].map((match) => [
      match.index!,
      match[1]!,
    ]),
  );
  const boundaries = [...inner.matchAll(CARD_HEADER_REGEX)]
    .filter((match) => {
      const index = match.index!;
      return (
        index === 0 ||
        (index >= 2 && inner[index - 1] === "\n" && inner[index - 2] === "\n")
      );
    })
    .map((match) => ({
      index: match.index!,
      slug: conceptSlugsByIndex.get(match.index!) ?? null,
    }));
  if (boundaries.length === 0) {
    return { preamble: inner, sections: [], pieces: [], framed: false };
  }

  const preamble = inner.slice(0, boundaries[0]!.index).trimEnd();
  const pieces = boundaries.map((boundary, index): CardBlockPiece => {
    const end = boundaries[index + 1]?.index;
    const text = inner.slice(boundary.index, end).trimEnd();
    return boundary.slug === null
      ? { kind: "other", text }
      : { kind: "card", slug: boundary.slug, text };
  });
  const sections = pieces.filter(
    (piece): piece is Extract<CardBlockPiece, { kind: "card" }> =>
      piece.kind === "card",
  );
  return { preamble, sections, pieces, framed: false };
}
