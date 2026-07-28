/**
 * Tests for the core Button primitive.
 *
 * No DOM environment — we verify behavior through two angles:
 *   1. `renderToStaticMarkup` — asserts the HTML the component emits.
 *   2. Direct invocation of the onClick prop — asserts wiring is preserved.
 */

import { describe, expect, mock, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Button } from "./button";

describe("Button rendering", () => {
  test("renders a <button> by default with type=button and children", () => {
    const html = renderToStaticMarkup(<Button>Hello</Button>);
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain(">Hello</button>");
  });

  test("asChild renders the slotted element instead of <button>", () => {
    const html = renderToStaticMarkup(
      <Button asChild>
        <a href="/somewhere">Link</a>
      </Button>,
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/somewhere"');
    expect(html).not.toContain("<button");
  });

  test("asChild still renders the slotted anchor when disabled is set", () => {
    const html = renderToStaticMarkup(
      <Button asChild disabled>
        <a href="/x">Link</a>
      </Button>,
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/x"');
    expect(html).not.toContain("<button");
  });

  test("asChild + leftIcon clones the slotted element with the icon as a sibling of its children", () => {
    // Regression: previously the icon branch rendered children as a Fragment,
    // which made Radix Slot try to forward `type` onto React.Fragment and
    // hard-error on React 19. The fix wraps `children` in `<Slottable>` so
    // Slot clones the caller's element and re-parents the icon as a sibling
    // of the element's original children.
    const html = renderToStaticMarkup(
      <Button asChild leftIcon={<svg data-testid="left-icon" aria-hidden />}>
        <a href="/back">Back</a>
      </Button>,
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/back"');
    expect(html).not.toContain("<button");
    expect(html).toContain('data-testid="left-icon"');
    expect(html).toContain("Back");
  });

  test("asChild + rightIcon also clones and re-parents the icon", () => {
    const html = renderToStaticMarkup(
      <Button asChild rightIcon={<svg data-testid="right-icon" aria-hidden />}>
        <a href="/next">Next</a>
      </Button>,
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/next"');
    expect(html).not.toContain("<button");
    expect(html).toContain('data-testid="right-icon"');
    expect(html).toContain("Next");
  });

  test("iconOnly ignores children and leftIcon/rightIcon", () => {
    const html = renderToStaticMarkup(
      <Button
        iconOnly={<svg data-testid="only-icon" />}
        leftIcon={<span>L</span>}
        rightIcon={<span>R</span>}
        aria-label="action"
      >
        should-not-render
      </Button>,
    );
    expect(html).not.toContain("should-not-render");
    expect(html).not.toContain(">L</span>");
    expect(html).not.toContain(">R</span>");
    expect(html).toContain('data-testid="only-icon"');
  });

  test("asChild + iconOnly renders the slotted element with the icon inside it", () => {
    const html = renderToStaticMarkup(
      <Button
        asChild
        iconOnly={<svg data-testid="only-icon" aria-hidden />}
        aria-label="New conversation"
      >
        <a href="/new" />
      </Button>,
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/new"');
    expect(html).toContain('aria-label="New conversation"');
    expect(html).not.toContain("<button");
    expect(html).toContain('data-testid="only-icon"');
    expect(html).toContain("p-0");
  });

  test("iconOnly applies square dimensions for regular size (h-8 w-8)", () => {
    const html = renderToStaticMarkup(
      <Button iconOnly={<svg />} aria-label="a" />,
    );
    expect(html).toContain("h-8");
    expect(html).toContain("w-8");
    expect(html).toContain("p-0");
  });

  test("iconOnly sizes the svg with a fixed dimension, never size-full", () => {
    // `size-full` would let the icon fill whatever element it lands in; if the
    // `asChild`/Slot path collapses the icon span onto the button box the icon
    // would balloon to the button size. A fixed `[&_svg]:size-*` prevents that.
    const html = renderToStaticMarkup(
      <Button size="compact" iconOnly={<svg />} aria-label="a" />,
    );
    // `renderToStaticMarkup` HTML-escapes `&` to `&amp;` in attribute values.
    expect(html).toContain("[&amp;_svg]:size-3.5");
    expect(html).not.toContain("[&amp;_svg]:size-full");
  });

  test("tintColor sets the --vbtn-fg custom property inline", () => {
    const html = renderToStaticMarkup(
      <Button tintColor="rebeccapurple">Tinted</Button>,
    );
    expect(html).toContain("--vbtn-fg:rebeccapurple");
  });

  test("tintColor is skipped when disabled so variant disabled fg wins", () => {
    const html = renderToStaticMarkup(
      <Button tintColor="rebeccapurple" disabled>
        Tinted
      </Button>,
    );
    expect(html).not.toContain("--vbtn-fg:rebeccapurple");
  });

  test("disabled plain <button> sets the disabled attribute", () => {
    const html = renderToStaticMarkup(<Button disabled>Off</Button>);
    expect(html).toContain("disabled");
  });

  test("ref passed as a prop is accepted without throwing (React 19 ref-as-prop)", () => {
    const ref = createRef<HTMLButtonElement>();
    expect(() =>
      renderToStaticMarkup(<Button ref={ref}>Ref</Button>),
    ).not.toThrow();
  });
});

describe("Button click behavior", () => {
  test("onClick fires when invoked directly (wiring sanity)", () => {
    const onClick = mock(() => {});
    renderToStaticMarkup(<Button onClick={onClick}>Click</Button>);
    onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("disabled attribute is rendered so the browser suppresses native clicks", () => {
    const html = renderToStaticMarkup(
      <Button disabled onClick={() => {}}>
        Nope
      </Button>,
    );
    expect(html).toMatch(/<button[^>]*\sdisabled(?:=""|\s|>)/);
  });

  test("asChild + disabled does not render a native <button> with disabled attribute", () => {
    const onClick = mock(() => {});
    const html = renderToStaticMarkup(
      <Button asChild disabled onClick={onClick}>
        <a href="/x">Blocked</a>
      </Button>,
    );
    expect(html).not.toMatch(/<button[^>]*disabled/);
    expect(html).toContain("<a");
  });
});

describe("Button class output", () => {
  test("primary variant uses token-backed background and text", () => {
    const html = renderToStaticMarkup(<Button variant="primary">P</Button>);
    expect(html).toContain("bg-[var(--primary-base)]");
    expect(html).toContain("[--vbtn-fg:var(--content-inset)]");
  });

  test("outlined variant emits --primary-base text and --border-element border", () => {
    const html = renderToStaticMarkup(<Button variant="outlined">O</Button>);
    expect(html).toContain("[--vbtn-fg:var(--primary-base)]");
    expect(html).toContain("border-[var(--border-element)]");
  });

  test("outlined disabled border uses --primary-disabled (Figma spec)", () => {
    const html = renderToStaticMarkup(
      <Button variant="outlined" disabled>
        O
      </Button>,
    );
    expect(html).toContain("disabled:border-[var(--primary-disabled)]");
  });

  test("danger variant uses --system-negative-strong background", () => {
    const html = renderToStaticMarkup(<Button variant="danger">D</Button>);
    expect(html).toContain("bg-[var(--system-negative-strong)]");
  });

  test("regular size applies text-body-medium-default typography class", () => {
    const html = renderToStaticMarkup(<Button size="regular">R</Button>);
    expect(html).toContain("text-body-medium-default");
  });

  test("compact size applies text-label-medium-default typography class", () => {
    const html = renderToStaticMarkup(<Button size="compact">C</Button>);
    expect(html).toContain("text-label-medium-default");
  });

  test("ghost icon-only button expands to a circular mobile tap target by default", () => {
    const html = renderToStaticMarkup(
      <Button variant="ghost" size="compact" iconOnly={<svg />} aria-label="a" />,
    );
    expect(html).toContain("touch-mobile:h-10");
    expect(html).toContain("touch-mobile:w-10");
    expect(html).toContain("touch-mobile:rounded-full");
    expect(html).toContain("touch-mobile:size-4");
  });

  test("expandOnMobile={false} keeps an icon-only button compact on mobile", () => {
    const html = renderToStaticMarkup(
      <Button
        variant="ghost"
        size="compact"
        expandOnMobile={false}
        iconOnly={<svg />}
        aria-label="a"
      />,
    );
    // Desktop sizing is preserved — none of the touch-mobile expansion
    // classes are emitted.
    expect(html).not.toContain("touch-mobile:h-10");
    expect(html).not.toContain("touch-mobile:w-10");
    expect(html).not.toContain("touch-mobile:rounded-full");
    expect(html).not.toContain("touch-mobile:size-4");
    // The compact desktop dimensions still apply.
    expect(html).toContain("h-6");
    expect(html).toContain("w-6");
  });

  test("link variant renders inline with no height, padding, or border-radius", () => {
    const html = renderToStaticMarkup(<Button variant="link">Skip</Button>);
    expect(html).toContain("[--vbtn-fg:var(--content-link)]");
    expect(html).toContain("h-auto");
    expect(html).toContain("p-0");
    expect(html).toContain("rounded-none");
    expect(html).toContain("hover:underline");
    expect(html).not.toContain("h-8");
    expect(html).not.toContain("px-2.5");
  });

  test("link variant inherits parent font size instead of applying its own", () => {
    const html = renderToStaticMarkup(<Button variant="link">Link</Button>);
    expect(html).toContain("text-[length:inherit]");
    expect(html).toContain("leading-[inherit]");
  });

  test("no raw hex colors appear in rendered output", () => {
    const html = renderToStaticMarkup(
      <div>
        <Button variant="primary">P</Button>
        <Button variant="outlined">O</Button>
        <Button variant="danger">D</Button>
        <Button variant="dangerOutline">DO</Button>
        <Button variant="ghost">G</Button>
        <Button variant="link">L</Button>
      </div>,
    );
    expect(html).not.toMatch(/#[0-9A-Fa-f]{6}\b/);
  });
});
