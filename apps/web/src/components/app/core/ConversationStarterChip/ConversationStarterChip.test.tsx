/**
 * Tests for the ConversationStarterChip primitive.
 *
 * The web workspace does not have @testing-library/react. We mirror the
 * "no DOM test harness" convention used by `Button.test.tsx` and exercise
 * behavior through `renderToStaticMarkup` plus direct invocation of the
 * rendered React tree.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  createElement,
  type ButtonHTMLAttributes,
  type ReactElement,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ConversationStarterChip,
  type ConversationStarterChipProps,
} from "@/components/app/core/ConversationStarterChip/ConversationStarterChip.js";

type ChipChildElement = ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;

/**
 * `ConversationStarterChip` is a forwardRef whose render fn returns a
 * `Button` element. Calling that render fn yields the inner element so we
 * can inspect props (e.g. `onClick`) without a DOM.
 */
function renderChip(props: ConversationStarterChipProps): ChipChildElement {
  const element = createElement(ConversationStarterChip, props);
  const renderFn = (
    element.type as unknown as {
      render: (p: ConversationStarterChipProps) => ChipChildElement;
    }
  ).render;
  return renderFn(element.props);
}

describe("ConversationStarterChip click behavior", () => {
  test("clicking invokes onSelect", () => {
    const onSelect = mock(() => {});
    const buttonEl = renderChip({ label: "Plan my week", onSelect });
    const onClick = buttonEl.props.onClick as
      | ((event: unknown) => void)
      | undefined;
    expect(typeof onClick).toBe("function");
    onClick!({});
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test("disabled suppresses onSelect", () => {
    const onSelect = mock(() => {});
    const html = renderToStaticMarkup(
      createElement(ConversationStarterChip, {
        label: "Suggestion unavailable",
        onSelect,
        disabled: true,
      }),
    );
    // Native <button disabled> — the browser will not dispatch click events,
    // so the chip relies on that guarantee for the disabled state. We assert
    // the `disabled` attribute is rendered, mirroring `Button.test.tsx`.
    expect(html).toMatch(/<button[^>]*\sdisabled(?:=""|\s|>)/);
    // The wrapper must not have invoked the handler as a side-effect of
    // rendering.
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("ConversationStarterChip rendering", () => {
  test("renders the supplied aria-label when provided", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationStarterChip, {
        label: "Plan my week",
        onSelect: () => {},
        "aria-label": "Start a planning conversation",
      }),
    );
    expect(html).toContain('aria-label="Start a planning conversation"');
  });

  test("renders the label text", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationStarterChip, {
        label: "Summarize my unread email",
        onSelect: () => {},
      }),
    );
    expect(html).toContain("Summarize my unread email");
  });

  test("uses body-medium-lighter typography on sm+ (not Button's default body-medium-default)", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationStarterChip, {
        label: "Plan my week",
        onSelect: () => {},
      }),
    );
    expect(html).toContain("sm:text-body-medium-lighter");
    expect(html).toContain("text-body-small-default");
    expect(html).not.toContain("text-body-medium-default");
  });

  test("applies the card-like layout (rounded-10, responsive padding, line-clamp-2)", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationStarterChip, {
        label: "Plan my week",
        onSelect: () => {},
      }),
    );
    expect(html).toContain("rounded-[10px]");
    // Mobile: tighter padding; sm+: original spacing.
    expect(html).toContain("px-3");
    expect(html).toContain("py-2");
    expect(html).toContain("sm:px-4");
    expect(html).toContain("sm:py-3");
    expect(html).toContain("line-clamp-2");
  });

  test("uses ghost Button with light fill + secondary content text", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationStarterChip, {
        label: "Plan my week",
        onSelect: () => {},
      }),
    );
    // Light fill (no outlined border) + secondary content text override.
    expect(html).toContain("bg-[var(--surface-lift)]");
    expect(html).toContain("[--vbtn-fg:var(--content-secondary)]");
    expect(html).not.toContain("border-[var(--border-element)]");
  });
});
