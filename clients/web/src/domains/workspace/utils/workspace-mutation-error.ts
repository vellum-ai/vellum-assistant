import type { TFunction } from "@/i18n";

/** A create or rename target whose name an existing sibling already uses. */
export class WorkspaceNameTakenError extends Error {
  readonly takenName: string;

  constructor(takenName: string) {
    super(`Workspace entry name is taken: ${takenName}`);
    this.name = "WorkspaceNameTakenError";
    this.takenName = takenName;
  }
}

export type WorkspaceMutation = "create" | "rename" | "delete";

/**
 * The message a failed workspace create, rename, or delete shows the user.
 *
 * The assistant's own error body is not shown: its text is not translated,
 * and the dialog only needs to say which action failed and what to try next.
 */
export function workspaceMutationErrorMessage(
  error: unknown,
  mutation: WorkspaceMutation,
  t: TFunction<"workspace">,
): string {
  if (error instanceof WorkspaceNameTakenError) {
    return t("workspaceTree.nameTaken", { name: error.takenName });
  }
  switch (mutation) {
    case "create":
      return t("workspaceTree.createFailed");
    case "rename":
      return t("workspaceTree.renameFailed");
    case "delete":
      return t("workspaceTree.deleteFailed");
  }
}
