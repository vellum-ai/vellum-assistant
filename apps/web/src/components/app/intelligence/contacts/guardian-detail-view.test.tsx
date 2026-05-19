/**
 * Tests for `GuardianDetailView`.
 *
 * The view manages local form state with `useState`, so we can't render it
 * outside React (the workspace has no `@testing-library/react`). Same
 * convention as `contact-merge-dialog.test.tsx`: pin the structural
 * contracts from source.
 *
 * The substantive behaviour being pinned here is the dirty-form-blocks-merge
 * guard — without it, clicking Merge while the guardian's Name/Notes are
 * dirty would silently drop the local edits when the contacts query is
 * invalidated after the mutation.
 */

import { describe, expect, test } from "bun:test";

async function readSource(): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  return fs.readFile(
    path.join(import.meta.dir, "guardian-detail-view.tsx"),
    "utf-8",
  );
}

describe("GuardianDetailView — source pinning", () => {
  test("tracks form dirtiness by comparing trimmed name + notes to originals", async () => {
    const source = await readSource();
    expect(source).toMatch(
      /const dirty =\s+trimmedName !== initialName\.trim\(\) \|\|\s+trimmedNotes !== \(contact\.notes \?\? ""\)\.trim\(\)/,
    );
  });

  test("Merge button is disabled while the form is dirty", async () => {
    const source = await readSource();
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

  test("Guardian view has no Delete button (single-guardian invariant)", async () => {
    // Sanity guard against future refactors that copy the contact view too
    // literally. The guardian cannot be deleted from this page — only merged.
    const source = await readSource();
    expect(source).not.toContain("Delete Contact");
    expect(source).not.toContain("onDelete");
  });

  test("Merge button is only rendered when `onMerge` is provided", async () => {
    const source = await readSource();
    expect(source).toMatch(/onMerge \? \(\s*<Button[\s\S]*?Merging…/);
  });
});
