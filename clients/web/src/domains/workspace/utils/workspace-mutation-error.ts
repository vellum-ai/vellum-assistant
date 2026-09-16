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
 * The assistant's message is not shown, even for a 400. `badRequestMessage`
 * exists for verdicts written for the user; the workspace routes' 400s are
 * developer strings ("Invalid path"), and the tree's own name check keeps
 * them from firing in normal use.
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
