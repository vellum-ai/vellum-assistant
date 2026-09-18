/**
 * Resolve the host computer-use tool behind a direct or skill-wrapped call.
 *
 * Skills expose their selected tool in structured input. Calls recovered only
 * from `_raw` retain their legacy behavior because this helper deliberately
 * does not parse a second input representation.
 */
export function resolveComputerUseToolName(
  name: string,
  input: unknown,
): string | undefined {
  if (name.startsWith("computer_use_")) {
    return name;
  }
  if (name !== "skill_execute" || input === null || typeof input !== "object") {
    return undefined;
  }
  const tool = (input as Record<string, unknown>).tool;
  return typeof tool === "string" && tool.startsWith("computer_use_")
    ? tool
    : undefined;
}

/** True when a tool call is backed by the host computer-use capability. */
export function isComputerUseToolCall(name: string, input: unknown): boolean {
  return resolveComputerUseToolName(name, input) !== undefined;
}
