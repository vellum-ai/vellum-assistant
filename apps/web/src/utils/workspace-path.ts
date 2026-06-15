/**
 * Map an absolute workspace path (as the assistant writes it in chat, e.g.
 * `/workspace/scratch/figma-cli/`) to the workspace-relative path the tree/file
 * APIs key on (`scratch/figma-cli`). The assistant emits paths prefixed with the
 * absolute workspace root (`getWorkspaceDir()`, injected into its system
 * prompt), which is `/workspace` in containers and a host path locally — so
 * stripping `root` handles both uniformly.
 */
export function toWorkspaceRelativePath(
  text: string,
  root: string,
): string | null {
  const cleanText = text.trim().replace(/\/+$/, "");
  const cleanRoot = root.replace(/\/+$/, "");
  if (cleanRoot.length === 0) return null;
  // The root itself maps to the empty relative path (the workspace landing
  // view).
  if (cleanText === cleanRoot) return "";
  if (!cleanText.startsWith(`${cleanRoot}/`)) return null;
  return cleanText.slice(cleanRoot.length + 1);
}
