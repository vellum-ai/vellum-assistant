/**
 * Rendering behaviour for the Typography primitive.
 *
 * No DOM environment, so these assert the emitted HTML via
 * `renderToStaticMarkup`, matching `button.test.tsx`.
 *
 * `Comp` is annotated `ElementType` rather than left to inference. With a
 * union of intrinsic tags, JSX intersects the props of every member, so `ref`
 * resolves to `RefObject<HTMLParagraphElement> & RefObject<HTMLDivElement> &
 * ...`, which nothing satisfies. `ElementType` is React's type for a
 * polymorphic slot and does not force that intersection. These tests pin the
 * runtime behaviour that annotation has to keep correct.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Typography } from "./typography";

describe("Typography rendering", () => {
  test("defaults to <span> and carries the variant class and data-slot", () => {
    const html = renderToStaticMarkup(
      <Typography variant="body-medium-default">Hello</Typography>,
    );
    expect(html).toContain("<span");
    expect(html).toContain("text-body-medium-default");
    expect(html).toContain('data-slot="typography"');
    expect(html).toContain(">Hello</span>");
  });

  test("renders the tag given by `as`", () => {
    const html = renderToStaticMarkup(
      <Typography as="h1" variant="title-large">
        Page title
      </Typography>,
    );
    expect(html).toContain("<h1");
    expect(html).toContain("text-title-large");
  });

  test("composes caller className after the variant class", () => {
    const html = renderToStaticMarkup(
      <Typography variant="title-small" className="mt-2">
        x
      </Typography>,
    );
    const variantAt = html.indexOf("text-title-small");
    const callerAt = html.indexOf("mt-2");
    expect(variantAt).toBeGreaterThan(-1);
    expect(callerAt).toBeGreaterThan(variantAt);
  });

  test("emits `for` when used as a label with htmlFor", () => {
    const html = renderToStaticMarkup(
      <Typography as="label" variant="label-small-default" htmlFor="field">
        Name
      </Typography>,
    );
    expect(html).toContain("<label");
    expect(html).toContain('for="field"');
  });
});

describe("Typography asChild", () => {
  test("renders the child element rather than `as`", () => {
    // The reason asChild exists: <th> is outside TypographyAs, and widening
    // that union would mean bolting element-specific props onto
    // TypographyProps one at a time.
    const html = renderToStaticMarkup(
      <Typography asChild variant="label-small-default">
        <th className="px-4 py-2">Source</th>
      </Typography>,
    );
    expect(html.startsWith("<th")).toBe(true);
    expect(html).toContain("text-label-small-default");
    expect(html).toContain("px-4 py-2");
    expect(html).toContain(">Source</th>");
  });

  test("keeps element-specific child props the props type does not declare", () => {
    // `href` is not on HTMLAttributes<HTMLElement>; the child keeps its own.
    const html = renderToStaticMarkup(
      <Typography asChild variant="body-small-lighter">
        <a href="/roadmap">Roadmap</a>
      </Typography>,
    );
    expect(html.startsWith("<a")).toBe(true);
    expect(html).toContain('href="/roadmap"');
    expect(html).toContain("text-body-small-lighter");
  });

  test("asChild wins over `as`", () => {
    const html = renderToStaticMarkup(
      <Typography asChild as="h1" variant="title-small">
        <td>cell</td>
      </Typography>,
    );
    expect(html.startsWith("<td")).toBe(true);
    expect(html).not.toContain("<h1");
  });

  test("still marks the slotted element with data-slot", () => {
    const html = renderToStaticMarkup(
      <Typography asChild variant="body-small-default">
        <button type="submit">Go</button>
      </Typography>,
    );
    expect(html.startsWith("<button")).toBe(true);
    expect(html).toContain('type="submit"');
    expect(html).toContain('data-slot="typography"');
  });
});

describe("Typography asChild prop precedence", () => {
  test("a child's own data-slot wins, and the variant class still merges", () => {
    // Radix Slot gives the child precedence on ordinary props, so composing
    // Typography around something that already identifies itself keeps the
    // child's identity. Styling does not depend on the marker: the variant
    // class merges either way, so only a `[data-slot="typography"]` selector
    // stops matching. Button and Card compose the same way.
    const html = renderToStaticMarkup(
      <Typography asChild variant="body-small-default">
        <button data-slot="button" className="px-2">
          Go
        </button>
      </Typography>,
    );
    expect(html).toContain('data-slot="button"');
    expect(html).not.toContain('data-slot="typography"');
    expect(html).toContain("text-body-small-default");
    expect(html).toContain("px-2");
  });
});
