import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CardSurface } from "@/domains/chat/components/surfaces/card-surface";
import type { Surface } from "@/domains/chat/types/types";

function surface(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "surface-123",
    surfaceType: "card",
    title: "Response limit reached",
    data: {
      title: "Response limit reached",
      subtitle: "The partial response above was saved.",
      body: "I hit the response limit before I could finish.",
    },
    actions: [
      {
        id: "relay_prompt",
        label: "Continue",
        style: "primary",
        data: { prompt: "Continue from where you stopped." },
      },
    ],
    ...overrides,
  };
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("CardSurface", () => {
  test("does not duplicate the card title when the surface envelope has the same title", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface surface={surface()} onAction={() => undefined} />,
    );

    expect(countOccurrences(rendered, "Response limit reached")).toBe(1);
    expect(rendered).toContain("The partial response above was saved.");
    expect(rendered).toContain("I hit the response limit before I could finish.");
  });

  test("renders the card data title instead of the envelope title", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Envelope title",
          data: {
            title: "Card title",
            subtitle: "Card subtitle",
            body: "Card body",
          },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("Card title");
    expect(rendered).not.toContain("Envelope title");
  });

  test("falls back to the envelope title when card data has no title", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Envelope fallback",
          data: {
            subtitle: "Card subtitle",
            body: "Card body",
          },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("Envelope fallback");
    expect(countOccurrences(rendered, "Envelope fallback")).toBe(1);
  });
});
