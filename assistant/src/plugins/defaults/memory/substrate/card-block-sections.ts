import { INJECTED_CONCEPT_HEADER_REGEX } from "./injected-block-slugs.js";

const CARD_HEADER_REGEX =
  /^# (?:memory\/concepts\/.+\.md|Skill: .+|CLI command: .+)$/gm;

export interface CardSection {
  slug: string;
  text: string;
}

export type CardBlockPiece =
  | { kind: "card"; slug: string; text: string }
  | { kind: "other"; text: string };

export function parseCardSections(inner: string): {
  preamble: string;
  sections: CardSection[];
  pieces: CardBlockPiece[];
} {
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
    return { preamble: inner, sections: [], pieces: [] };
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
  return { preamble, sections, pieces };
}
