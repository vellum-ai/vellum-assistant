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
 * Stand in for `root-layout.tsx`'s app shell: the portal host with the sheet's
 * own portal node and another overlay parked in it, and the chrome around the
 * host, one piece of which is already inert for reasons of its own.
 */
function mountShell() {
  const shell = document.createElement("div");
  const banner = document.createElement("div");
  banner.setAttribute("inert", "");
  const header = document.createElement("div");
  const host = document.createElement("div");
  host.id = OVERLAY_HOST_ID;
  const sheetPortal = document.createElement("div");
  const sheet = document.createElement("div");
  sheetPortal.append(sheet);
  const parkedOverlay = document.createElement("div");
  host.append(parkedOverlay, sheetPortal);
  shell.append(banner, header, host);
  document.body.append(shell);
  return { shell, banner, header, host, sheetPortal, sheet, parkedOverlay };
}

function renderGate(active: boolean, sheet: HTMLElement | null) {
  const sheetRef = { current: sheet };
  return renderHook(
    ({ active: isActive }) => useInertBehindSheet(isActive, sheetRef),
    { initialProps: { active } },
  );
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("useInertBehindSheet", () => {
  test("takes everything around the sheet out of reach while it covers them", () => {
    const shell = mountShell();

    renderGate(true, shell.sheet);

    expect(shell.header.hasAttribute("inert")).toBe(true);
    // The other overlays share the host and sit beside the sheet's portal
    // node, covered just the same.
    expect(shell.parkedOverlay.hasAttribute("inert")).toBe(true);
    // Neither the host nor the sheet's own node: either would take the room
    // down with the chrome behind it.
    expect(shell.host.hasAttribute("inert")).toBe(false);
    expect(shell.sheetPortal.hasAttribute("inert")).toBe(false);
    expect(shell.sheet.hasAttribute("inert")).toBe(false);
  });

  test("hands back only what it took", () => {
    const shell = mountShell();

    const { rerender } = renderGate(true, shell.sheet);
    rerender({ active: false });

    expect(shell.header.hasAttribute("inert")).toBe(false);
    expect(shell.parkedOverlay.hasAttribute("inert")).toBe(false);
    // Inert before the camera opened, so inert after it closes.
    expect(shell.banner.hasAttribute("inert")).toBe(true);
  });

  test("marks nothing while the sheet rests below the header", () => {
    const shell = mountShell();

    renderGate(false, shell.sheet);

    expect(shell.header.hasAttribute("inert")).toBe(false);
    expect(shell.parkedOverlay.hasAttribute("inert")).toBe(false);
  });

  test("covers what mounts beside the host while the sheet is flush", async () => {
    // The status banner is the concrete case: it renders nothing until
    // assistant state changes, then lands beside the host mid-camera.
    const shell = mountShell();
    const { rerender } = renderGate(true, shell.sheet);

    const banner = document.createElement("div");
    shell.shell.append(banner);
    await waitFor(() => {
      expect(banner.hasAttribute("inert")).toBe(true);
    });

    rerender({ active: false });
    expect(banner.hasAttribute("inert")).toBe(false);
  });

  test("covers an overlay that mounts inside the host while the sheet is flush", async () => {
    const shell = mountShell();
    const { rerender } = renderGate(true, shell.sheet);

    const overlay = document.createElement("div");
    shell.host.append(overlay);
    await waitFor(() => {
      expect(overlay.hasAttribute("inert")).toBe(true);
    });

    rerender({ active: false });
    expect(overlay.hasAttribute("inert")).toBe(false);
  });

  test("leaves the sheet's own churn alone", async () => {
    const shell = mountShell();
    renderGate(true, shell.sheet);

    const sheetChild = document.createElement("div");
    shell.sheet.append(sheetChild);
    // Give the observer a turn to report, so a subtree watch would show.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sheetChild.hasAttribute("inert")).toBe(false);
    expect(shell.sheet.hasAttribute("inert")).toBe(false);
  });

  test("is a no-op with no portal host in the document", () => {
    // Pop-out windows and the very first commit render no host. The sheet
    // falls back to the body there, so there is no shell to hold back.
    const stray = document.createElement("div");
    document.body.append(stray);
    const sheet = document.createElement("div");
    stray.append(sheet);

    renderGate(true, sheet);

    expect(stray.hasAttribute("inert")).toBe(false);
  });
});
