/**
 * Tests for the OptionCard primitive and its group.
 *
 * No DOM environment, mirroring `filter-chip.test.tsx`: selection state is the
 * caller's, so the markup `renderToStaticMarkup` emits is the contract. The
 * click wiring and the group's keyboard behavior need a live tree, so that one
 * section mounts into a happy-dom window the way `markdown-message.test.tsx`
 * does.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { OptionCard, OptionCardGroup } from "./option-card";

const SOURCE = readFileSync(join(import.meta.dir, "option-card.tsx"), "utf8");

function buttonHtml(html: string): string {
  const match = html.match(/<button[\s\S]*?<\/button>/);
  if (!match) {
    throw new Error("no <button> in markup");
  }
  return match[0];
}

describe("OptionCard semantics", () => {
  test("renders a real button with the option-card slot", () => {
    const html = renderToStaticMarkup(
      <OptionCard selected={false} title="Inbox" />,
    );
    expect(html.startsWith("<button")).toBe(true);
    expect(html).toContain('type="button"');
    expect(html).toContain('data-slot="option-card"');
  });

  test("single mode is a radio with aria-checked and the radio mark", () => {
    const html = renderToStaticMarkup(
      <OptionCard selectionMode="single" selected title="Inbox" />,
    );
    expect(html).toContain('role="radio"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('data-mark="radio"');
    expect(html).not.toContain('data-mark="checkbox"');
    // Radio's geometry and override hooks: 16px ring, 8px dot.
    expect(html).toContain("rounded-full");
    expect(html).toContain("h-2 w-2");
    expect(html).toContain("--radio-checked-bg");
    expect(html).not.toContain("<svg");
  });

  test("multiple mode is a checkbox with aria-checked and the check mark", () => {
    const html = renderToStaticMarkup(
      <OptionCard selectionMode="multiple" selected title="Inbox" />,
    );
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('data-mark="checkbox"');
    expect(html).not.toContain('data-mark="radio"');
    // Checkbox's geometry and fill: 4px corners, primary-active, a check.
    expect(html).toContain("rounded-[4px]");
    expect(html).toContain("--primary-active");
    expect(html).toContain("<svg");
  });

  test("an unselected card reports aria-checked=false and draws an empty mark", () => {
    const single = renderToStaticMarkup(
      <OptionCard selectionMode="single" selected={false} title="Inbox" />,
    );
    expect(single).toContain('aria-checked="false"');
    expect(single).not.toContain("h-2 w-2");

    const multiple = renderToStaticMarkup(
      <OptionCard selectionMode="multiple" selected={false} title="Inbox" />,
    );
    expect(multiple).toContain('aria-checked="false"');
    expect(multiple).toContain('data-mark="checkbox"');
    expect(multiple).not.toContain("<svg");
  });

  test("the mark is hidden from assistive tech and hideMark drops it", () => {
    const shown = renderToStaticMarkup(<OptionCard selected title="Inbox" />);
    expect(shown).toMatch(/<span aria-hidden="true" data-slot="option-card-mark"/);

    const hidden = renderToStaticMarkup(
      <OptionCard selected hideMark title="Inbox" />,
    );
    expect(hidden).not.toContain("option-card-mark");
    expect(hidden).toContain('aria-checked="true"');
  });

  test("markPosition moves the mark to either side of the title", () => {
    const start = renderToStaticMarkup(
      <OptionCard selected={false} markPosition="start" title="Inbox" />,
    );
    expect(start.indexOf("option-card-mark")).toBeLessThan(
      start.indexOf("option-card-title"),
    );
    const end = renderToStaticMarkup(
      <OptionCard selected={false} markPosition="end" title="Inbox" />,
    );
    expect(end.indexOf("option-card-mark")).toBeGreaterThan(
      end.indexOf("option-card-title"),
    );
  });

  test("is named by its title and described by its description", () => {
    const html = renderToStaticMarkup(
      <OptionCard selected={false} title="Inbox" description="Triage mail" />,
    );
    const titleId = html.match(/id="([^"]+)" data-slot="option-card-title"/)?.[1];
    const descriptionId = html.match(
      /id="([^"]+)" data-slot="option-card-description"/,
    )?.[1];
    expect(titleId).toBeTruthy();
    expect(descriptionId).toBeTruthy();
    expect(html).toContain(`aria-labelledby="${titleId}"`);
    expect(html).toContain(`aria-describedby="${descriptionId}"`);
  });

  test("a caller aria-label replaces the title as the name", () => {
    const html = renderToStaticMarkup(
      <OptionCard selected={false} title="Inbox" aria-label="Pick inbox" />,
    );
    expect(html).toContain('aria-label="Pick inbox"');
    expect(html).not.toContain("aria-labelledby");
  });
});

describe("OptionCard states", () => {
  test("data-selected is present only when selected, and the look differs", () => {
    const selected = renderToStaticMarkup(<OptionCard selected title="A" />);
    const unselected = renderToStaticMarkup(
      <OptionCard selected={false} title="A" />,
    );
    expect(selected).toContain('data-selected=""');
    expect(unselected).not.toContain("data-selected");
    expect(selected).toContain("border-[var(--primary-base)]");
    expect(unselected).toContain("border-[var(--border-element)]");
    expect(unselected).toContain("enabled:hover:bg-[var(--surface-base)]");
  });

  test("the filled variant keeps its fill and marks selection with the border", () => {
    const selected = renderToStaticMarkup(
      <OptionCard variant="filled" selected title="A" />,
    );
    const unselected = renderToStaticMarkup(
      <OptionCard variant="filled" selected={false} title="A" />,
    );
    expect(selected).toContain("bg-[var(--surface-overlay)]");
    expect(selected).toContain("border-[var(--primary-base)]");
    expect(unselected).toContain("border-transparent");
  });

  test("carries the library keyboard-focus ring", () => {
    const html = renderToStaticMarkup(<OptionCard selected={false} title="A" />);
    expect(html).toContain("keyboard-focus:ring-2");
    expect(html).toContain("keyboard-focus:ring-[var(--ring)]");
  });

  test("disabled sets the native attribute", () => {
    const html = renderToStaticMarkup(
      <OptionCard selected={false} disabled title="A" />,
    );
    expect(buttonHtml(html)).toMatch(/<button[^>]* disabled=""/);
    expect(html).toContain("disabled:cursor-not-allowed");
  });

  test("renders the leading, trailing and description slots", () => {
    const html = renderToStaticMarkup(
      <OptionCard
        selected={false}
        title="A"
        description="Details"
        leading={<svg data-testid="lead" />}
        trailing={<svg data-testid="trail" />}
      />,
    );
    expect(html).toContain('data-slot="option-card-leading"');
    expect(html).toContain('data-slot="option-card-trailing"');
    expect(html).toContain(">Details</span>");
    expect(html.indexOf('data-testid="lead"')).toBeLessThan(
      html.indexOf("option-card-title"),
    );
    expect(html.indexOf('data-testid="trail"')).toBeGreaterThan(
      html.indexOf("option-card-title"),
    );
  });
});

describe("OptionCard content model", () => {
  test("nothing inside the button is a <div> or <p>", () => {
    for (const orientation of ["horizontal", "vertical"] as const) {
      const html = renderToStaticMarkup(
        <OptionCard
          selected
          selectionMode="multiple"
          orientation={orientation}
          title="A"
          description="Details"
          leading={<svg />}
          trailing={<svg />}
        />,
      );
      const inner = buttonHtml(html);
      expect(inner).not.toContain("<div");
      expect(inner).not.toMatch(/<p[\s>]/);
    }
  });

  test("the source uses tokens, never raw hex or Tailwind palette colours", () => {
    expect(SOURCE).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(SOURCE).not.toMatch(
      /\b(?:bg|text|border|ring)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/,
    );
  });
});

describe("OptionCardGroup", () => {
  test("single mode is a radiogroup of radios with one tab stop", () => {
    const html = renderToStaticMarkup(
      <OptionCardGroup selectionMode="single" aria-label="Plan">
        <OptionCard selected={false} title="Free" />
        <OptionCard selected title="Pro" />
      </OptionCardGroup>,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Plan"');
    expect(html).toContain('data-slot="option-card-group"');
    expect(html.match(/role="radio"/g)).toHaveLength(2);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(1);
    expect(html).toMatch(/tabindex="0"[^>]*aria-checked="true"/);
  });

  test("multiple mode is a group of checkboxes, each its own tab stop", () => {
    const html = renderToStaticMarkup(
      <OptionCardGroup selectionMode="multiple" aria-labelledby="heading">
        <OptionCard selected={false} title="Email" />
        <OptionCard selected title="Calendar" />
      </OptionCardGroup>,
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-labelledby="heading"');
    expect(html.match(/role="checkbox"/g)).toHaveLength(2);
    expect(html).not.toContain("tabindex");
  });

  test("a card's own selectionMode wins over the group's", () => {
    const html = renderToStaticMarkup(
      <OptionCardGroup selectionMode="multiple" aria-label="Mixed">
        <OptionCard selectionMode="single" selected={false} title="A" />
      </OptionCardGroup>,
    );
    expect(html).toContain('role="radio"');
  });

  test("columns picks the grid", () => {
    const one = renderToStaticMarkup(
      <OptionCardGroup aria-label="One">{null}</OptionCardGroup>,
    );
    const two = renderToStaticMarkup(
      <OptionCardGroup columns={2} aria-label="Two">
        {null}
      </OptionCardGroup>,
    );
    expect(one).toContain("grid-cols-1");
    expect(two).toContain("grid-cols-2");
    expect(two).toContain("auto-rows-fr");
  });

  test("disabled reaches every card", () => {
    const html = renderToStaticMarkup(
      <OptionCardGroup disabled aria-label="Plan">
        <OptionCard selected={false} title="Free" />
        <OptionCard selected title="Pro" />
      </OptionCardGroup>,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html.match(/ disabled=""/g)).toHaveLength(2);
  });
});

describe("OptionCard in a live DOM", () => {
  let win: Window;
  let host: HTMLElement;
  let root: Root;
  const restore: Array<() => void> = [];

  /** Installs one global for the duration of this section, restoring after. */
  function install(name: string, value: unknown): void {
    const globals = globalThis as unknown as Record<string, unknown>;
    const had = name in globals;
    const previous = globals[name];
    globals[name] = value;
    restore.push(() => {
      if (had) {
        globals[name] = previous;
      } else {
        delete globals[name];
      }
    });
  }

  beforeAll(() => {
    win = new Window({ url: "https://localhost" });
    install("window", win);
    install("document", win.document);
    install("navigator", win.navigator);
    install("Element", win.Element);
    install("HTMLElement", win.HTMLElement);
    install("Node", win.Node);
    install("IS_REACT_ACT_ENVIRONMENT", true);
    host = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(host as unknown as Node);
    root = createRoot(host);
  });

  afterAll(() => {
    act(() => root.unmount());
    while (restore.length > 0) {
      restore.pop()?.();
    }
    void win.close();
  });

  function show(node: ReactNode): void {
    act(() => {
      root.render(node);
    });
  }

  function cards(): HTMLButtonElement[] {
    return Array.from(
      host.querySelectorAll<HTMLButtonElement>('[data-slot="option-card"]'),
    );
  }

  function press(target: HTMLElement, key: string): void {
    act(() => {
      target.dispatchEvent(
        new win.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }) as unknown as Event,
      );
    });
  }

  function Plans({
    initial = null,
    selectOnFocus,
    onSelect,
  }: {
    initial?: string | null;
    selectOnFocus?: boolean;
    onSelect?: (id: string) => void;
  }) {
    const [value, setValue] = useState<string | null>(initial);
    return (
      <OptionCardGroup aria-label="Plan" selectOnFocus={selectOnFocus}>
        {["free", "pro", "team"].map((id) => (
          <OptionCard
            key={id}
            title={id}
            selected={value === id}
            disabled={id === "pro"}
            onSelect={() => {
              onSelect?.(id);
              setValue(id);
            }}
          />
        ))}
      </OptionCardGroup>
    );
  }

  test("onSelect fires on click, after onClick, unless onClick vetoes it", () => {
    const calls: string[] = [];
    let veto = false;
    show(
      <OptionCard
        selected={false}
        title="A"
        onClick={(event) => {
          calls.push("click");
          if (veto) {
            event.preventDefault();
          }
        }}
        onSelect={() => calls.push("select")}
      />,
    );
    act(() => cards()[0].click());
    expect(calls).toEqual(["click", "select"]);

    veto = true;
    act(() => cards()[0].click());
    expect(calls).toEqual(["click", "select", "click"]);
  });

  test("a disabled card does not select", () => {
    const onSelect = mock(() => {});
    show(<OptionCard selected={false} disabled title="A" onSelect={onSelect} />);
    act(() => cards()[0].click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("with nothing checked the first enabled card is the tab stop", () => {
    show(<Plans key="none" />);
    expect(cards().map((card) => card.tabIndex)).toEqual([0, -1, -1]);
  });

  test("the checked card is the only tab stop, and the stop follows selection", () => {
    show(<Plans key="team" initial="team" />);
    expect(cards().map((card) => card.tabIndex)).toEqual([-1, -1, 0]);
    act(() => cards()[0].click());
    expect(cards().map((card) => card.tabIndex)).toEqual([0, -1, -1]);
  });

  test("arrow keys move focus and select, skipping disabled cards and wrapping", () => {
    const onSelect = mock((_: string) => {});
    show(<Plans key="arrows" initial="free" onSelect={onSelect} />);
    const [free, , team] = cards();
    act(() => free.focus());

    press(free, "ArrowDown");
    expect(win.document.activeElement as unknown).toBe(team);
    expect(onSelect).toHaveBeenLastCalledWith("team");
    expect(team.getAttribute("aria-checked")).toBe("true");

    press(team, "ArrowRight");
    expect(win.document.activeElement as unknown).toBe(free);
    expect(onSelect).toHaveBeenLastCalledWith("free");

    press(free, "ArrowUp");
    expect(win.document.activeElement as unknown).toBe(team);
  });

  test("selectOnFocus={false} moves focus without selecting", () => {
    const onSelect = mock((_: string) => {});
    show(
      <Plans
        key="no-select"
        initial="free"
        selectOnFocus={false}
        onSelect={onSelect}
      />,
    );
    const [free, , team] = cards();
    act(() => free.focus());
    press(free, "ArrowDown");
    expect(win.document.activeElement as unknown).toBe(team);
    expect(onSelect).not.toHaveBeenCalled();
    expect(free.getAttribute("aria-checked")).toBe("true");
  });

  test("multiple mode leaves arrow keys alone", () => {
    show(
      <OptionCardGroup selectionMode="multiple" aria-label="Tasks">
        <OptionCard selected={false} title="Email" />
        <OptionCard selected={false} title="Calendar" />
      </OptionCardGroup>,
    );
    const [email] = cards();
    act(() => email.focus());
    press(email, "ArrowDown");
    expect(win.document.activeElement as unknown).toBe(email);
    expect(cards().map((card) => card.getAttribute("tabindex"))).toEqual([
      null,
      null,
    ]);
  });
});
