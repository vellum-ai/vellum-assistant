import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import { OPENAI_COMPATIBLE_PROVIDER } from "@/domains/settings/ai/constants";
import type { ProviderConnection } from "@/generated/daemon/types.gen";

/**
 * Custom providers share the flat provider list with built-ins, so a custom
 * provider's display identity must not collide with a built-in provider's id
 * or display name, nor with another custom provider's identity. The daemon
 * enforces the same rules on the connection routes; this mirror exists for
 * inline feedback before submit.
 */

/** Built-in provider ids and display names, lowercased — names a custom
 * provider may not take. */
export const RESERVED_PROVIDER_NAMES = new Set(
  Object.entries(PROVIDER_DISPLAY_NAMES).flatMap(([id, display]) => [
    id.toLowerCase(),
    display.toLowerCase(),
  ]),
);

export type CustomProviderNameConflict = "reserved" | "duplicate";

export const CUSTOM_PROVIDER_NAME_ERRORS: Record<
  CustomProviderNameConflict,
  string
> = {
  reserved: "That name belongs to a built-in provider. Pick another.",
  duplicate: "A custom provider with this name already exists.",
};

/**
 * Why `label` is unusable as a custom provider's name, or null when it's
 * fine. `selfName` excludes the row being edited from the duplicate check.
 */
export function customProviderNameConflict(
  label: string,
  connections: ProviderConnection[] | undefined,
  selfName?: string,
): CustomProviderNameConflict | null {
  const lower = label.trim().toLowerCase();
  if (!lower) {
    return null;
  }
  if (RESERVED_PROVIDER_NAMES.has(lower)) {
    return "reserved";
  }
  const duplicate = (connections ?? []).some(
    (c) =>
      c.provider === OPENAI_COMPATIBLE_PROVIDER &&
      c.name !== selfName &&
      (c.label && c.label.trim() !== "" ? c.label : c.name).toLowerCase() ===
        lower,
  );
  return duplicate ? "duplicate" : null;
}
