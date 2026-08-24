/**
 * The override context, exercised through the real hook. Rendered to static
 * markup: the server snapshot answers hover-capable, so what these pin is
 * that a mounted override wins over that answer and an absent one defers to
 * it.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  HoverCapabilityOverride,
  useHoverCapable,
} from "./hover-capability";

function Probe() {
  return <span>{useHoverCapable() ? "capable" : "incapable"}</span>;
}

describe("HoverCapabilityOverride", () => {
  test("a subtree override wins over the ambient answer", () => {
    const html = renderToStaticMarkup(
      <HoverCapabilityOverride hoverCapable={false}>
        <Probe />
      </HoverCapabilityOverride>,
    );

    expect(html).toContain("incapable");
  });

  test("an explicit hover-capable override also wins", () => {
    const html = renderToStaticMarkup(
      <HoverCapabilityOverride hoverCapable>
        <Probe />
      </HoverCapabilityOverride>,
    );

    expect(html).toContain(">capable");
  });

  test("without an override the ambient answer stands", () => {
    expect(renderToStaticMarkup(<Probe />)).toContain(">capable");
  });

  test("the override is scoped: a sibling outside it is untouched", () => {
    const html = renderToStaticMarkup(
      <>
        <HoverCapabilityOverride hoverCapable={false}>
          <Probe />
        </HoverCapabilityOverride>
        <Probe />
      </>,
    );

    expect(html).toContain("incapable");
    expect(html.endsWith("<span>capable</span>")).toBe(true);
  });
});
