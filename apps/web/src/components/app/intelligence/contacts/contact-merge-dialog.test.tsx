/**
 * Tests for `ContactMergeDialog`.
 *
 * The dialog body is stateful (search input, donor selection step, error
 * surface) and uses React hooks. The web workspace doesn't ship
 * `@testing-library/react`, so we mix two strategies — same convention as
 * `AutoTopUpPaymentMethodModal.test.tsx`:
 *
 *   1. Unit tests for the pure helpers that drive the user-visible copy
 *      (`formatSurvivorName`, `classifyMergedChannels`). These are the bits
 *      most likely to regress under refactors.
 *   2. Source-pinning tests for the JSX-only contracts that the hook-using
 *      view enforces — labels, semantic tokens, role attributes, footer
 *      buttons in each step. A change to any of these pinned strings should
 *      trip the test so it gets revisited intentionally.
 *
 * The smoke test at the bottom keeps the export wiring honest.
 */

import { describe, expect, test } from "bun:test";
import { isValidElement } from "react";

import type { ContactPayload } from "@/lib/contacts/types.js";

import {
  ContactMergeDialog,
  classifyMergedChannels,
  formatSurvivorName,
} from "@/components/app/intelligence/contacts/contact-merge-dialog.js";

function contact(
  overrides: Partial<ContactPayload> & Pick<ContactPayload, "id" | "displayName">,
): ContactPayload {
  return {
    role: "contact",
    interactionCount: 0,
    channels: [],
    ...overrides,
  };
}

function channel(
  overrides: Partial<ContactPayload["channels"][number]> &
    Pick<ContactPayload["channels"][number], "id" | "type" | "address">,
): ContactPayload["channels"][number] {
  return {
    isPrimary: false,
    status: "active",
    policy: "allow",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("formatSurvivorName", () => {
  test("non-guardian uses the display name verbatim", () => {
    expect(
      formatSurvivorName(contact({ id: "1", displayName: "Alice" })),
    ).toBe("Alice");
  });

  test("non-guardian with empty display name falls back to 'this contact'", () => {
    expect(formatSurvivorName(contact({ id: "1", displayName: "" }))).toBe(
      "this contact",
    );
  });

  test("guardian with the principal placeholder renders as 'you'", () => {
    expect(
      formatSurvivorName(
        contact({
          id: "g",
          displayName: "vellum-principal-abc123",
          role: "guardian",
        }),
      ),
    ).toBe("you");
  });

  test("guardian with a real name renders as '<name> (you)'", () => {
    expect(
      formatSurvivorName(
        contact({ id: "g", displayName: "Vargas", role: "guardian" }),
      ),
    ).toBe("Vargas (you)");
  });

  test("guardian with empty display name renders as 'you'", () => {
    expect(
      formatSurvivorName(
        contact({ id: "g", displayName: "", role: "guardian" }),
      ),
    ).toBe("you");
  });
});

describe("classifyMergedChannels", () => {
  test("classifies channels not already on the survivor as 'moved'", () => {
    const survivor = contact({ id: "s", displayName: "S", channels: [] });
    const donor = contact({
      id: "d",
      displayName: "D",
      channels: [
        channel({ id: "c1", type: "telegram", address: "@alice" }),
        channel({ id: "c2", type: "phone", address: "+15551234" }),
      ],
    });
    const { moved, duplicates } = classifyMergedChannels(survivor, donor);
    expect(moved.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(duplicates).toEqual([]);
  });

  test("classifies channels already on the survivor as 'duplicates' (case-insensitive address)", () => {
    const survivor = contact({
      id: "s",
      displayName: "S",
      channels: [channel({ id: "s1", type: "email", address: "ALICE@example.com" })],
    });
    const donor = contact({
      id: "d",
      displayName: "D",
      channels: [
        channel({ id: "c1", type: "email", address: "alice@example.com" }),
        channel({ id: "c2", type: "telegram", address: "@a" }),
      ],
    });
    const { moved, duplicates } = classifyMergedChannels(survivor, donor);
    expect(moved.map((c) => c.id)).toEqual(["c2"]);
    expect(duplicates.map((c) => c.id)).toEqual(["c1"]);
  });

  test("skips revoked donor channels entirely (they're already dead, won't migrate)", () => {
    const survivor = contact({ id: "s", displayName: "S" });
    const donor = contact({
      id: "d",
      displayName: "D",
      channels: [
        channel({
          id: "c1",
          type: "phone",
          address: "+1555",
          status: "revoked",
        }),
        channel({ id: "c2", type: "phone", address: "+1666" }),
      ],
    });
    const { moved, duplicates } = classifyMergedChannels(survivor, donor);
    expect(moved.map((c) => c.id)).toEqual(["c2"]);
    expect(duplicates).toEqual([]);
  });

  test("matching survivor channel blocks the donor's channel regardless of status (mirrors backend unique constraint)", () => {
    // `(type, address)` is globally UNIQUE in contact_channels, so a
    // revoked +1234 on the survivor and an active +1234 on the donor
    // cannot coexist. Pin the conservative behaviour: if the survivor
    // already has a row with this (type, address) for any reason, the
    // donor's matching channel is classified as a duplicate.
    const survivor = contact({
      id: "s",
      displayName: "S",
      channels: [
        channel({
          id: "s1",
          type: "phone",
          address: "+1234",
          status: "revoked",
        }),
      ],
    });
    const donor = contact({
      id: "d",
      displayName: "D",
      channels: [channel({ id: "d1", type: "phone", address: "+1234" })],
    });
    const { moved, duplicates } = classifyMergedChannels(survivor, donor);
    expect(moved).toEqual([]);
    expect(duplicates.map((c) => c.id)).toEqual(["d1"]);
  });

  test("matches duplicates only when channel type AND address agree", () => {
    const survivor = contact({
      id: "s",
      displayName: "S",
      channels: [channel({ id: "s1", type: "phone", address: "+1555" })],
    });
    const donor = contact({
      id: "d",
      displayName: "D",
      channels: [
        // Same address but a different type — not a duplicate.
        channel({ id: "c1", type: "whatsapp", address: "+1555" }),
      ],
    });
    const { moved, duplicates } = classifyMergedChannels(survivor, donor);
    expect(moved.map((c) => c.id)).toEqual(["c1"]);
    expect(duplicates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Source pinning — the dialog uses hooks so we can't render its tree from a
// plain function call. Read the source and pin the structural promises this
// file makes to its callers and to the user.
// ---------------------------------------------------------------------------

async function readSource(): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  return fs.readFile(
    path.join(import.meta.dir, "contact-merge-dialog.tsx"),
    "utf-8",
  );
}

describe("ContactMergeDialog — source pinning", () => {
  test("composes the Modal primitive with `size=md`", async () => {
    const source = await readSource();
    expect(source).toContain("<Modal.Root");
    expect(source).toContain('<Modal.Content size="md"');
    expect(source).toContain("<Modal.Header>");
    expect(source).toContain("<Modal.Body");
    expect(source).toContain("<Modal.Footer>");
  });

  test("title icon is GitMerge", async () => {
    const source = await readSource();
    expect(source).toMatch(/<Modal\.Title icon={GitMerge}/);
  });

  test("title text follows the picker / confirm pattern", async () => {
    const source = await readSource();
    // Picker-step title.
    expect(source).toContain("`Merge another contact into ${survivorLabel}`");
    // Confirm-step title quotes the donor name explicitly.
    expect(source).toContain(
      '`Merge "${donor.displayName}" into ${survivorLabel}?`',
    );
  });

  test("description copy explains what merging does in plain English", async () => {
    const source = await readSource();
    expect(source).toContain(
      "The contact you pick will be deleted. Its channels and notes will be added to this one.",
    );
    expect(source).toContain(
      "Channels and notes from the merged contact will move over. The merged contact will be deleted.",
    );
  });

  test("footer renders Cancel in the picker step and Back + Merge in the confirm step", async () => {
    const source = await readSource();
    // Picker step shows a Cancel button.
    expect(source).toMatch(/<Button[^>]*variant="outlined"[\s\S]*?Cancel/);
    // Confirm step shows Back (outlined) and Merge (danger).
    expect(source).toMatch(/<Button[\s\S]*?variant="outlined"[\s\S]*?Back/);
    expect(source).toMatch(/<Button[\s\S]*?variant="danger"[\s\S]*?Merge/);
  });

  test("Merge button surfaces a `Merging…` label while pending", async () => {
    const source = await readSource();
    expect(source).toContain('pending ? "Merging…" : "Merge"');
  });

  test("candidate row is a button with role=option for keyboard a11y", async () => {
    const source = await readSource();
    expect(source).toContain('role="listbox"');
    expect(source).toContain('role="option"');
  });

  test("empty-state copy is rendered when no candidates are available", async () => {
    const source = await readSource();
    expect(source).toContain("No other contacts available to merge.");
  });

  test("error message uses the negative-strong token", async () => {
    const source = await readSource();
    expect(source).toMatch(
      /errorMessage[\s\S]*?text-\(--system-negative-strong\)/,
    );
    expect(source).toContain('role="alert"');
  });

  test("Modal.Root.onOpenChange ignores close attempts while pending", async () => {
    // Guards against accidental cancel mid-merge.
    const source = await readSource();
    expect(source).toMatch(/if \(!next && !pending\) onClose\(\)/);
  });

  test("wrapper re-keys the inner component per open to reset internal state", async () => {
    const source = await readSource();
    expect(source).toContain(
      '`${props.survivor.id}:${props.open ? "open" : "closed"}`',
    );
  });
});

// ---------------------------------------------------------------------------
// Smoke
// ---------------------------------------------------------------------------

describe("ContactMergeDialog smoke", () => {
  test("ContactMergeDialog is a function component and the outer wrapper returns a valid element", () => {
    expect(typeof ContactMergeDialog).toBe("function");
    // The outer wrapper itself is hookless — just re-keys the inner. Calling
    // it returns an element whose key encodes both survivor.id and open state.
    const element = ContactMergeDialog({
      open: true,
      survivor: contact({ id: "keep", displayName: "S" }),
      candidates: [],
      pending: false,
      errorMessage: null,
      onMerge: () => {},
      onClose: () => {},
    });
    expect(isValidElement(element)).toBe(true);
    expect((element as { key: string }).key).toBe("keep:open");
  });
});
