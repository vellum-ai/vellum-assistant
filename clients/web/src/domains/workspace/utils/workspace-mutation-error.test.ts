import { describe, expect, test } from "bun:test";

import { fixedT } from "@/i18n";

import {
  WorkspaceNameTakenError,
  workspaceMutationErrorMessage,
} from "./workspace-mutation-error";

const t = fixedT("workspace");

describe("workspaceMutationErrorMessage", () => {
  test("a taken name names the entry, whichever action hit it", () => {
    const error = new WorkspaceNameTakenError("notes.md");
    expect(workspaceMutationErrorMessage(error, "create", t)).toBe(
      t("workspaceTree.nameTaken", { name: "notes.md" }),
    );
    expect(workspaceMutationErrorMessage(error, "rename", t)).toBe(
      t("workspaceTree.nameTaken", { name: "notes.md" }),
    );
    expect(t("workspaceTree.nameTaken", { name: "notes.md" })).toContain(
      "notes.md",
    );
  });

  test("any other failure says which action failed", () => {
    const error = new Error("500 from the assistant");
    expect(workspaceMutationErrorMessage(error, "create", t)).toBe(
      t("workspaceTree.createFailed"),
    );
    expect(workspaceMutationErrorMessage(error, "rename", t)).toBe(
      t("workspaceTree.renameFailed"),
    );
    expect(workspaceMutationErrorMessage(error, "delete", t)).toBe(
      t("workspaceTree.deleteFailed"),
    );
  });

  test("the assistant's own error text never reaches the message", () => {
    const message = workspaceMutationErrorMessage(
      new Error("Invalid path"),
      "create",
      t,
    );
    expect(message).not.toContain("Invalid path");
  });

  test("a thrown value that is not an Error still gets the action's message", () => {
    expect(workspaceMutationErrorMessage("boom", "delete", t)).toBe(
      t("workspaceTree.deleteFailed"),
    );
  });
});
