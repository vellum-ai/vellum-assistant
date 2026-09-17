import type { HostProxyCapability } from "../channels/types.js";
import type { OwnerInfo } from "../tools/types.js";

/**
 * Built-in host tools and the connected-client capability each one requires.
 */
export const HOST_TOOL_TO_CAPABILITY: ReadonlyMap<string, HostProxyCapability> =
  new Map<string, HostProxyCapability>([
    ["host_bash", "host_bash"],
    ["host_file_read", "host_file"],
    ["host_file_write", "host_file"],
    ["host_file_edit", "host_file"],
    ["host_file_transfer", "host_file"],
    ["host_browser", "host_browser"],
  ]);

/**
 * Host-proxy capabilities whose tools are contributed by bundled skills.
 * Built-in capabilities such as `host_bash`, `host_file`, and `host_browser`
 * belong in `HOST_TOOL_TO_CAPABILITY` instead.
 */
export const HOST_PROXY_SKILL_PREACTIVATIONS: ReadonlyArray<{
  capability: HostProxyCapability;
  skillId: string;
}> = [
  { capability: "host_cu", skillId: "computer-use" },
  // Annotation needs the dedicated window capability advertised by the
  // client. The general computer-use transport does not imply it.
  { capability: "host_cu_annotate", skillId: "screen-annotation" },
  { capability: "host_app_control", skillId: "app-control" },
];

const HOST_SKILL_TO_CAPABILITY = new Map<string, HostProxyCapability>(
  HOST_PROXY_SKILL_PREACTIVATIONS.map(
    ({ capability, skillId }) => [skillId, capability] as const,
  ),
);

/**
 * Resolve the live client capability required by a registered host-backed
 * tool. Ownership is part of the lookup so an extension tool with a host-like
 * name is never mistaken for a built-in or bundled host tool.
 */
export function hostProxyCapabilityForTool(
  toolName: string,
  owner: OwnerInfo | undefined,
): HostProxyCapability | undefined {
  if (owner?.kind === "default") {
    return HOST_TOOL_TO_CAPABILITY.get(toolName);
  }
  if (owner?.kind === "skill") {
    return HOST_SKILL_TO_CAPABILITY.get(owner.id);
  }
  return undefined;
}
