/**
 * Tests for `ContactDetailView`.
 *
 * The view manages local form state with `useState`, so we can't render it
 * outside React (the workspace has no `@testing-library/react`). Same
 * convention as `contact-merge-dialog.test.tsx`: pin the structural
 * contracts from source.
 *
 * The substantive behaviour being pinned here is the dirty-form-blocks-merge
 * guard — without it, clicking Merge while Name/Notes are dirty would
 * silently drop the local edits when the contacts query is invalidated after
 * the mutation.
 */

import { describe, expect, test } from "bun:test";

async function readSource(): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  return fs.readFile(
    path.join(import.meta.dir, "contact-detail-view.tsx"),
    "utf-8",
  );
}

describe("ContactDetailView — source pinning", () => {
  test("tracks form dirtiness by comparing trimmed name + notes to originals", async () => {
    const source = await readSource();
    expect(source).toContain(
      "const dirty = trimmedName !== originalName || trimmedNotes !== originalNotes",
    );
  });

  test("Merge button is disabled while the form is dirty", async () => {
    const source = await readSource();
    // The disabled-expression on the Merge button must include `dirty ||`
    // alongside the other guard conditions.
    const mergeButtonBlock = source.match(
      /onClick={onMerge}[\s\S]*?{mergePending \? "Merging…" : "Merge…"}/,
    );
    expect(mergeButtonBlock).not.toBeNull();
    expect(mergeButtonBlock?.[0]).toContain("dirty ||");
  });

  test("Merge button title explains the dirty-form block", async () => {
    const source = await readSource();
    expect(source).toContain("Save your changes before merging");
  });

  test("Save button precedes Merge button in the action row", async () => {
    // Visual ordering: Save → Merge… → Delete. Pin the ordering so refactors
    // that reshuffle the action row trip the test.
    const source = await readSource();
    const saveIdx = source.indexOf('{savePending ? "Saving…" : "Save"}');
    const mergeIdx = source.indexOf('{mergePending ? "Merging…" : "Merge…"}');
    const deleteIdx = source.indexOf(
      '{deletePending ? "Deleting…" : "Delete Contact"}',
    );
    expect(saveIdx).toBeGreaterThan(-1);
    expect(mergeIdx).toBeGreaterThan(saveIdx);
    expect(deleteIdx).toBeGreaterThan(mergeIdx);
  });

  test("Merge button is only rendered when `onMerge` is provided", async () => {
    const source = await readSource();
    expect(source).toMatch(/onMerge \? \(\s*<Button[\s\S]*?Merging…/);
  });
});
