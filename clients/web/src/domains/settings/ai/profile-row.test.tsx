/**
 * Which kebab actions a Profiles row offers, focused on the Disable/Enable
 * pair.
 *
 * Disabling is how a default (managed) profile is hidden: they cannot be
 * deleted, since the code catalog re-serves them whatever the workspace
 * holds. The row offers it on a managed profile only against an assistant new
 * enough to accept the write. Custom profiles do not consult the gate,
 * because they have always been disableable.
 *
 * Enable is deliberately never gated, so a profile disabled by a newer
 * assistant stays recoverable after a downgrade.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ProfileRow } from "@/domains/settings/ai/profile-row";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import type { InferenceProfileSummary } from "@/generated/daemon/types.gen";

/** Shaped as `GET /v1/inference/profiles` returns them. */
function summary(
  over: Partial<InferenceProfileSummary> & { name: string },
): InferenceProfileSummary {
  return {
    label: null,
    provider: "anthropic",
    model: "claude-opus-5",
    status: "active",
    source: "user",
    availability: { status: "ok" },
    ...over,
  };
}

function renderRow(profile: InferenceProfileSummary) {
  return render(
    <ProfileRow
      profile={profile}
      isActiveProfile={false}
      selected={false}
      onOpen={() => {}}
      onMakeActive={() => {}}
      onSetStatus={() => {}}
      onDelete={() => {}}
    />,
  );
}

async function openKebab(profile: InferenceProfileSummary): Promise<string[]> {
  renderRow(profile);
  const displayName = profile.label ?? profile.name;
  const trigger = screen.getByLabelText(
    `Actions for ${displayName}`,
  ) as HTMLButtonElement;
  // Radix DropdownMenu opens on pointerdown, not click.
  act(() => {
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    trigger.click();
  });
  const menu = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[role="menu"]');
    if (!el) {
      throw new Error("menu did not open");
    }
    return el;
  });
  return [...menu.querySelectorAll('[role="menuitem"]')].map(
    (el) => el.textContent?.trim() ?? "",
  );
}

/** The first release that accepts a managed disable. */
const SUPPORTING_VERSION = "0.11.4";
const OLD_VERSION = "0.11.3";

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("ProfileRow: Disable on a managed profile", () => {
  beforeEach(() => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-asst", SUPPORTING_VERSION, "asst-1");
  });

  test("offers Disable when the assistant allows it for this profile", async () => {
    const items = await openKebab(
      summary({
        name: "balanced",
        label: "Balanced",
        source: "managed",
      }),
    );
    expect(items).toContain("Disable");
    // Still no Delete: the catalog would re-serve it.
    expect(items).not.toContain("Delete");
  });

  test("offers Enable for a disabled managed profile", async () => {
    const items = await openKebab(
      summary({
        name: "balanced",
        label: "Balanced",
        source: "managed",
        status: "disabled",
      }),
    );
    expect(items).toContain("Enable");
    expect(items).not.toContain("Disable");
  });
});

describe("ProfileRow: Disable against an older assistant", () => {
  beforeEach(() => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-asst", OLD_VERSION, "asst-1");
  });

  test("hides Disable on a managed profile", async () => {
    // Such an assistant rejects the write, and the user has no other way to
    // remove a default from their pickers there.
    const items = await openKebab(
      summary({ name: "balanced", label: "Balanced", source: "managed" }),
    );
    expect(items).not.toContain("Disable");
  });

  test("still offers Enable on a disabled managed profile", async () => {
    const items = await openKebab(
      summary({
        name: "balanced",
        label: "Balanced",
        source: "managed",
        status: "disabled",
      }),
    );
    expect(items).toContain("Enable");
  });

  test("still offers Disable on a custom profile", async () => {
    const items = await openKebab(summary({ name: "mine", label: "Mine" }));
    expect(items).toContain("Disable");
    expect(items).toContain("Delete");
  });
});
