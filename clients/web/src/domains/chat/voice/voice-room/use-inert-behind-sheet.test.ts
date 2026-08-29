/**
 * Tests for {@link useInertBehindSheet}.
 *
 * The gate is what keeps the flush camera sheet honest: the sheet is
 * non-modal, so nothing but this stops VoiceOver and the tab key from walking
 * into a thread header buried under a full-screen viewfinder. The restore is
 * the other half. Closing the camera has to hand back exactly what the gate
 * took, and nothing it found already inert.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, renderHook, waitFor } from "@testing-library/react";

import { OVERLAY_HOST_ID, useInertBehindSheet } from "./use-inert-behind-sheet";

/**
 * Stand in for `root-layout.tsx`'s app shell: the sheet's portal host and the
 * chrome around it, one of which is already inert for reasons of its own.
 */
function mountShell() {
  const shell = document.createElement("div");
  const banner = document.createElement("div");
  banner.setAttribute("inert", "");
  const header = document.createElement("div");
  const host = document.createElement("div");
  host.id = OVERLAY_HOST_ID;
  shell.append(banner, header, host);
  document.body.append(shell);
  return { shell, banner, header, host };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("useInertBehindSheet", () => {
  test("takes the host's siblings out of reach while the sheet covers them", () => {
    const shell = mountShell();

    renderHook(({ active }) => useInertBehindSheet(active), {
      initialProps: { active: true },
    });

    expect(shell.header.hasAttribute("inert")).toBe(true);
    // The sheet lives in the host, so inerting it would take the room down
    // with the chrome behind it.
    expect(shell.host.hasAttribute("inert")).toBe(false);
  });

  test("hands back only what it took", () => {
    const shell = mountShell();

    const { rerender } = renderHook(
      ({ active }) => useInertBehindSheet(active),
      { initialProps: { active: true } },
    );
    rerender({ active: false });

    expect(shell.header.hasAttribute("inert")).toBe(false);
    // Inert before the camera opened, so inert after it closes.
    expect(shell.banner.hasAttribute("inert")).toBe(true);
  });

  test("marks nothing while the sheet rests below the header", () => {
    const shell = mountShell();

    renderHook(({ active }) => useInertBehindSheet(active), {
      initialProps: { active: false },
    });

    expect(shell.header.hasAttribute("inert")).toBe(false);
  });

  test("covers a sibling that mounts while the sheet is flush", async () => {
    // The status banner is the concrete case: it renders nothing until
    // assistant state changes, then lands beside the host mid-camera.
    const shell = mountShell();
    const { rerender } = renderHook(
      ({ active }) => useInertBehindSheet(active),
      { initialProps: { active: true } },
    );

    const banner = document.createElement("div");
    shell.shell.append(banner);
    await waitFor(() => {
      expect(banner.hasAttribute("inert")).toBe(true);
    });

    rerender({ active: false });
    expect(banner.hasAttribute("inert")).toBe(false);
  });

  test("leaves the sheet's own churn inside the host alone", async () => {
    const shell = mountShell();
    renderHook(({ active }) => useInertBehindSheet(active), {
      initialProps: { active: true },
    });

    const sheetChild = document.createElement("div");
    shell.host.append(sheetChild);
    // Give the observer a turn to report, so a wrong subtree watch would show.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sheetChild.hasAttribute("inert")).toBe(false);
    expect(shell.host.hasAttribute("inert")).toBe(false);
  });

  test("is a no-op with no portal host in the document", () => {
    // Pop-out windows and the very first commit render no host. The sheet
    // falls back to the body there, so there is no shell to hold back.
    const stray = document.createElement("div");
    document.body.append(stray);

    renderHook(({ active }) => useInertBehindSheet(active), {
      initialProps: { active: true },
    });

    expect(stray.hasAttribute("inert")).toBe(false);
  });
});
