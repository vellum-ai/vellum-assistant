import { afterEach, describe, expect, test } from "bun:test";
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
    expect(rendered).toContain(
      'sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"',
    );
    expect(rendered).not.toContain("allow-same-origin");
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
