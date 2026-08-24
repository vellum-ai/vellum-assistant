/**
 * Tests for `PackageSwitchConfirmModal`. The dialog is pure layout over three
 * pure helpers, and the header tile draws nothing without an active assistant,
 * so the harness only has to leave that store empty.
 *
 * Radix portals the dialog, so queries come off `render`'s `baseElement`
 * (document.body), not the mount container.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";

import { PackageSwitchConfirmModal } from "@/domains/settings/billing/plans/package-switch-confirm-modal";
import {
  CHECKLIST_HEADING,
  CONTINUE_LABEL,
  DOWNGRADE_CAPTION,
  DOWNGRADE_CHECKLIST_HEADING,
  DOWNGRADE_NOTE,
  SWITCH_CAPTION,
  UPGRADE_CAPTION,
} from "@/domains/settings/billing/plans/package-switch-copy";
import {
  PLAN_TIER_COPY,
  downgradeLabel,
} from "@/domains/settings/billing/plans/plans-copy";
import {
  makeProPackage,
  makeSuperPackage,
} from "@/domains/settings/billing/plans/pro-package-test-fixtures";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/** The package's own catalog blurb — never the dialog's description. */
const CATALOG_BLURB = makeProPackage().description;
/** A server-shipped package this bundle has no tier copy for. */
const UNKNOWN_TIER_PACKAGE = makeProPackage({ key: "mega", name: "Mega" });

let onCancel = mock(() => {});
let onConfirm = mock(() => {});

function renderModal(
  props: Partial<ComponentProps<typeof PackageSwitchConfirmModal>> = {},
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PackageSwitchConfirmModal
        open
        relation="upgrade"
        packageName="Mighty"
        targetPackage={makeProPackage()}
        pending={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  onCancel = mock(() => {});
  onConfirm = mock(() => {});
  // No resolved assistant: the tile holds its square and draws nothing, which
  // keeps the avatar compositor out of the run.
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

afterEach(() => {
  cleanup();
});

describe("PackageSwitchConfirmModal", () => {
  test("an upgrade prices the target package and lists what it includes", () => {
    const { getByText, getByRole, getByTestId } = renderModal();

    getByRole("heading", { name: "Upgrade to Mighty" });
    getByText("$30/mo");
    getByText(UPGRADE_CAPTION);
    getByText(CHECKLIST_HEADING);
    getByText("Small machine (2 vCPU, 3 GiB)");
    getByText("10 GB storage");
    getByText("Mighty Usage");
    expect(getByTestId("confirm-package-switch-button").textContent).toBe(
      CONTINUE_LABEL,
    );
  });

  test("a downgrade keeps the explicit destructive label and the no-refund note", () => {
    const { getByText, getByRole, getByTestId } = renderModal({
      relation: "downgrade",
    });

    getByRole("heading", { name: downgradeLabel("Mighty") });
    getByText(DOWNGRADE_CAPTION);
    getByText(DOWNGRADE_NOTE);
    expect(getByTestId("confirm-package-switch-button").textContent).toBe(
      downgradeLabel("Mighty"),
    );
  });

  test("the header glyph and the checklist framing track the direction", () => {
    const upgrade = renderModal();
    upgrade.getByTestId("assistant-avatar-tile");
    expect(upgrade.queryByTestId("package-switch-warning-tile")).toBeNull();
    upgrade.getByText(CHECKLIST_HEADING);

    cleanup();

    const downgrade = renderModal({ relation: "downgrade" });
    downgrade.getByTestId("package-switch-warning-tile");
    expect(downgrade.queryByTestId("assistant-avatar-tile")).toBeNull();
    downgrade.getByText(DOWNGRADE_CHECKLIST_HEADING);
    expect(downgrade.queryByText(CHECKLIST_HEADING)).toBeNull();
  });

  test("the dialog opens focused on Cancel, not on the confirm", () => {
    const { getByRole, getByTestId } = renderModal({ relation: "downgrade" });

    expect(document.activeElement).toBe(
      getByRole("button", { name: "Cancel" }),
    );
    expect(document.activeElement).not.toBe(
      getByTestId("confirm-package-switch-button"),
    );
  });

  test("the checklist owns the specs — the catalog blurb never doubles them", () => {
    // The real blurbs are the checklist in sentence form ("Medium machine,
    // 30 GB of storage, and $45 in monthly credits."), so quoting one in the
    // header would state the same three facts twice, 40px apart.
    const downgrade = renderModal({ relation: "downgrade" });
    expect(downgrade.queryByText(CATALOG_BLURB)).toBeNull();
    expect(downgrade.queryByText(PLAN_TIER_COPY.mighty.tagline)).toBeNull();
    downgrade.getByText("10 GB storage");

    cleanup();

    // Same for a tier this bundle has no tagline for: title-only header.
    const unknownTier = renderModal({
      packageName: "Mega",
      targetPackage: UNKNOWN_TIER_PACKAGE,
    });
    expect(unknownTier.queryByText(CATALOG_BLURB)).toBeNull();
    unknownTier.getByText("10 GB storage");
  });

  test("an upgrade with tier copy is described by its tagline", () => {
    const { getByRole, getByText } = renderModal();

    getByText(PLAN_TIER_COPY.mighty.tagline);
    const describedBy = getByRole("dialog").getAttribute("aria-describedby");
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      PLAN_TIER_COPY.mighty.tagline,
    );
  });

  // Radix stamps `aria-describedby` at `Modal.Description`'s id whether or not
  // that element renders, so every relation × catalog combination has to land
  // on an element that exists — or on no attribute at all. A destructive switch
  // is described by its safeguard, never by a spec line.
  const DESCRIBED_BY_CASES: {
    label: string;
    props: Partial<ComponentProps<typeof PackageSwitchConfirmModal>>;
    /** Expected description text, or null for no `aria-describedby`. */
    text: string | null;
  }[] = [
    {
      label: "upgrade, known tier",
      props: {},
      text: PLAN_TIER_COPY.mighty.tagline,
    },
    {
      label: "upgrade, unknown tier",
      props: { packageName: "Mega", targetPackage: UNKNOWN_TIER_PACKAGE },
      text: null,
    },
    {
      label: "upgrade, no target",
      props: { packageName: "", targetPackage: null },
      text: null,
    },
    {
      label: "switch, known tier",
      props: { relation: "switch" },
      text: PLAN_TIER_COPY.mighty.tagline,
    },
    {
      label: "switch, unknown tier",
      props: {
        relation: "switch",
        packageName: "Mega",
        targetPackage: UNKNOWN_TIER_PACKAGE,
      },
      text: null,
    },
    {
      label: "switch, no target",
      props: { relation: "switch", packageName: "", targetPackage: null },
      text: null,
    },
    {
      label: "downgrade, known tier",
      props: { relation: "downgrade" },
      text: DOWNGRADE_NOTE,
    },
    {
      label: "downgrade, unknown tier",
      props: {
        relation: "downgrade",
        packageName: "Mega",
        targetPackage: UNKNOWN_TIER_PACKAGE,
      },
      text: DOWNGRADE_NOTE,
    },
    {
      label: "downgrade, no target",
      props: { relation: "downgrade", packageName: "", targetPackage: null },
      text: DOWNGRADE_NOTE,
    },
  ];

  for (const { label, props, text } of DESCRIBED_BY_CASES) {
    test(`aria-describedby resolves to a rendered element — ${label}`, () => {
      const { getByRole } = renderModal(props);
      const dialog = getByRole("dialog");

      if (text === null) {
        expect(dialog.hasAttribute("aria-describedby")).toBe(false);
        return;
      }
      const describedBy = dialog.getAttribute("aria-describedby");
      expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
        text,
      );
    });
  }

  test("the downgrade safeguard note survives an unresolved target", () => {
    const { getByText, queryByText } = renderModal({
      relation: "downgrade",
      packageName: "Mighty",
      targetPackage: null,
    });

    getByText(DOWNGRADE_NOTE);
    expect(queryByText(DOWNGRADE_CHECKLIST_HEADING)).toBeNull();
  });

  test("a direction-neutral switch names both proration outcomes", () => {
    const { getByText, getByRole, getByTestId, queryByText } = renderModal({
      relation: "switch",
    });

    getByRole("heading", { name: "Switch to Mighty" });
    getByText(SWITCH_CAPTION);
    expect(queryByText(DOWNGRADE_NOTE)).toBeNull();
    expect(getByTestId("confirm-package-switch-button").textContent).toBe(
      CONTINUE_LABEL,
    );
  });

  test("tier copy with extra features appends them after the derived rows", () => {
    const { getByText, getAllByRole } = renderModal({
      packageName: "Super",
      targetPackage: makeSuperPackage(),
    });

    getByText("$100/mo");
    expect(getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "Medium machine (2.5 vCPU, 5 GiB)",
      "30 GB storage",
      "Super Usage",
      "Assistant email and subdomain",
    ]);
  });

  test("an unresolved target renders the header and the actions only", () => {
    const { getByText, getByRole, getByTestId, queryByText } = renderModal({
      packageName: "",
      targetPackage: null,
    });

    getByRole("heading", { name: "Upgrade to" });
    getByTestId("assistant-avatar-tile");
    expect(queryByText(CHECKLIST_HEADING)).toBeNull();
    expect(queryByText(UPGRADE_CAPTION)).toBeNull();
    expect(queryByText("10 GB storage")).toBeNull();
    getByTestId("confirm-package-switch-button");
    getByText("Cancel");
  });

  test("a pending change disables both actions", () => {
    const { getByTestId, getByRole } = renderModal({ pending: true });

    expect(
      (getByTestId("confirm-package-switch-button") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("the actions call back to the parent, which owns the mutation", () => {
    const { getByTestId, getByRole } = renderModal();

    fireEvent.click(getByTestId("confirm-package-switch-button"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(0);

    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
