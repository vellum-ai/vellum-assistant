/**
 * The picker composes exactly one name from the pair on screen, and that name
 * is the only thing it ever asks to have applied. What it refuses to ask for
 * matters as much: a pair the installed build ships no bundle for, and the
 * icon already on the home screen, both leave Set inert rather than erroring.
 *
 * Radix portals the dialog, so the queries here run against `document`, not
 * the mount container.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

import { AppIconModal } from "@/domains/settings/components/app-icon-modal";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { appIconNameForTraits } from "@/utils/avatar-app-icon";
import type { AppIconModalProps } from "@/domains/settings/components/app-icon-modal";

/** Every icon the generator emits from the catalog, as a full shell would. */
const ALL_ICONS = BUNDLED_COMPONENTS.eyeStyles.flatMap((eyeStyle) =>
  BUNDLED_COMPONENTS.colors.map((color) =>
    appIconNameForTraits(eyeStyle.id, color.id),
  ),
);

const DEFAULT_ICON = appIconNameForTraits("quirky", "green");

/** The style one step on from `id`, read off the catalog the rows cycle. */
function eyeStyleAfter(id: string, step: number): string {
  const styles = BUNDLED_COMPONENTS.eyeStyles;
  const index = styles.findIndex((eyeStyle) => eyeStyle.id === id);
  return styles[(index + step + styles.length) % styles.length]!.id;
}

function colorAfter(id: string, step: number): string {
  const colors = BUNDLED_COMPONENTS.colors;
  const index = colors.findIndex((color) => color.id === id);
  return colors[(index + step + colors.length) % colors.length]!.id;
}

/** A control by its visible text, or by its label when it is a chevron. */
function buttonByText(name: string): HTMLButtonElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (element) =>
      element.textContent?.trim() === name ||
      element.getAttribute("aria-label") === name,
  );
}

/**
 * Press a control and let whatever it started settle. Applying is async all
 * the way down, so the press is awaited even where the assertion that follows
 * is about the press itself.
 */
async function press(name: string) {
  const button = buttonByText(name);
  if (!button) {
    throw new Error(`No button reading "${name}"`);
  }
  await act(async () => {
    fireEvent.click(button);
  });
}

function alertText(): string | null {
  const alert = document.querySelector<HTMLElement>('[role="alert"]');
  return alert?.textContent?.trim() ?? null;
}

/** The eye style and color the rows currently read, in catalog ids. */
function rowValues(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="modal-body"] span'),
  ).map((element) => element.textContent ?? "");
}

interface Harness {
  onApply: ReturnType<typeof mock>;
  onReset: ReturnType<typeof mock>;
  onClose: ReturnType<typeof mock>;
}

function renderModal(
  overrides: Partial<AppIconModalProps> = {},
  applied = true,
): Harness {
  const onApply = mock(async (_name: string) => applied);
  const onReset = mock(async () => applied);
  const onClose = mock(() => {});
  render(
    <AppIconModal
      open
      onClose={onClose}
      components={BUNDLED_COMPONENTS}
      currentIcon={null}
      targetIcon={null}
      canSyncAvatar={false}
      availableIcons={ALL_ICONS}
      onApply={onApply}
      onReset={onReset}
      {...overrides}
    />,
  );
  return { onApply, onReset, onClose };
}

afterEach(() => {
  cleanup();
});

describe("AppIconModal", () => {
  test("draws nothing while closed", async () => {
    renderModal({ open: false });

    expect(document.querySelector('[data-testid="app-icon-modal"]')).toBeNull();
  });

  test("opens on the pair the default icon is drawn from", async () => {
    const { onApply } = renderModal();

    await press("Set app icon");

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]?.[0]).toBe(DEFAULT_ICON);
  });

  test("opens on the icon already applied, whatever the avatar says", async () => {
    const { onApply } = renderModal({
      currentIcon: appIconNameForTraits("goofy", "teal"),
      targetIcon: appIconNameForTraits("grumpy", "green"),
    });

    // Cycling once proves the seed: the pair moves on from goofy on teal.
    await press("Next eyes");

    expect(rowValues()).toContain(eyeStyleAfter("goofy", 1));
    await press("Set app icon");
    expect(onApply.mock.calls[0]?.[0]).toBe(
      appIconNameForTraits(eyeStyleAfter("goofy", 1), "teal"),
    );
  });

  test("opens on the avatar's pair when no icon has been applied", async () => {
    const { onApply } = renderModal({
      targetIcon: appIconNameForTraits("bashful", "pink"),
    });

    await press("Set app icon");

    expect(onApply.mock.calls[0]?.[0]).toBe(
      appIconNameForTraits("bashful", "pink"),
    );
  });

  test("cycling either trait composes the name from the pair on screen", async () => {
    const { onApply } = renderModal({
      currentIcon: appIconNameForTraits("curious", "orange"),
    });

    await press("Previous eyes");
    await press("Next color");

    await press("Set app icon");
    expect(onApply.mock.calls[0]?.[0]).toBe(
      appIconNameForTraits(
        eyeStyleAfter("curious", -1),
        colorAfter("orange", 1),
      ),
    );
  });

  test("cycling past the end of a trait wraps around", async () => {
    const last = BUNDLED_COMPONENTS.eyeStyles.at(-1)!.id;
    const first = BUNDLED_COMPONENTS.eyeStyles[0]!.id;
    const { onApply } = renderModal({
      currentIcon: appIconNameForTraits(last, "green"),
    });

    await press("Next eyes");

    expect(rowValues()).toContain(first);
    await press("Set app icon");
    expect(onApply.mock.calls[0]?.[0]).toBe(
      appIconNameForTraits(first, "green"),
    );
  });

  test("refuses to re-apply the icon already on the home screen", async () => {
    renderModal({ currentIcon: DEFAULT_ICON });

    expect(buttonByText("Set app icon")?.disabled).toBe(true);
  });

  test("refuses a pair the installed build ships no bundle for", async () => {
    const { onApply } = renderModal({
      availableIcons: [appIconNameForTraits("angry", "yellow")],
    });

    expect(buttonByText("Set app icon")?.disabled).toBe(true);
    expect(onApply).not.toHaveBeenCalled();
  });

  test("closes once the home screen holds the icon", async () => {
    const { onApply, onClose } = renderModal();

    await press("Set app icon");

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(alertText()).toBeNull();
  });

  test("names a swap iOS did not carry out and stays up for the retry", async () => {
    const onApply = mock(async (_name: string) => false);
    const onClose = mock(() => {});
    render(
      <AppIconModal
        open
        onClose={onClose}
        components={BUNDLED_COMPONENTS}
        currentIcon={null}
        targetIcon={null}
        canSyncAvatar={false}
        availableIcons={ALL_ICONS}
        onApply={onApply}
        onReset={async () => false}
      />,
    );

    await press("Set app icon");

    await waitFor(() => {
      expect(alertText()).toBe(
        "iOS did not change your home screen icon. You can try again.",
      );
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(buttonByText("Set app icon")?.disabled).toBe(false);

    await press("Set app icon");
    await waitFor(() => {
      expect(onApply).toHaveBeenCalledTimes(2);
    });
  });

  test("offers no way back to the default while the default is showing", async () => {
    renderModal();

    expect(buttonByText("Reset to default")).toBeUndefined();
  });

  test("resets to the default icon and closes", async () => {
    const { onReset, onClose } = renderModal({ currentIcon: DEFAULT_ICON });

    await press("Reset to default");

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  test("names a reset iOS did not carry out", async () => {
    const { onClose } = renderModal({ currentIcon: DEFAULT_ICON }, false);

    await press("Reset to default");

    await waitFor(() => {
      expect(alertText()).toBe(
        "iOS did not change your home screen icon. You can try again.",
      );
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("offers no avatar shortcut without a character avatar", async () => {
    renderModal();

    expect(buttonByText("Match avatar")).toBeUndefined();
  });

  test("offers no avatar shortcut once the home screen already matches", async () => {
    renderModal({
      currentIcon: appIconNameForTraits("gentle", "purple"),
      targetIcon: appIconNameForTraits("gentle", "purple"),
      canSyncAvatar: false,
    });

    expect(buttonByText("Match avatar")).toBeUndefined();
  });

  test("the avatar shortcut moves the pair without applying anything", async () => {
    const { onApply } = renderModal({
      currentIcon: appIconNameForTraits("goofy", "teal"),
      targetIcon: appIconNameForTraits("gentle", "purple"),
      canSyncAvatar: true,
    });

    await press("Match avatar");

    expect(onApply).not.toHaveBeenCalled();
    expect(rowValues()).toContain("gentle");
    expect(rowValues()).toContain("purple");

    await press("Set app icon");
    expect(onApply.mock.calls[0]?.[0]).toBe(
      appIconNameForTraits("gentle", "purple"),
    );
  });

  test("previews the pair on screen rather than the applied icon", async () => {
    renderModal({ currentIcon: appIconNameForTraits("goofy", "teal") });

    await press("Next color");

    const field = document.querySelector(
      '[data-testid="app-icon-preview-field"]',
    );
    const teal = BUNDLED_COMPONENTS.colors.find((c) => c.id === "teal")!.hex;
    const next = BUNDLED_COMPONENTS.colors.find(
      (c) => c.id === colorAfter("teal", 1),
    )!.hex;
    expect(field?.getAttribute("fill")).toBe(next);
    expect(next).not.toBe(teal);
  });
});
