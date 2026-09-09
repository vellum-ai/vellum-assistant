/**
 * The model vocabulary the Coding Agents settings card offers.
 *
 * These are claude-agent-acp's resolver aliases, not Assistant catalog model
 * ids: the adapter accepts them alongside full model ids and rejects anything
 * else with `Invalid value for config option model: <value>`. The list is a
 * settings convenience only. It never constrains what a session can run on,
 * and the MODEL card in the ACP run panel always lists what the adapter
 * itself reports for the live session, which is the authority.
 *
 * Anything outside this list is still a valid setting: the card routes it
 * through its "Custom model" row and saves the typed text untouched, which is
 * what makes a second adapter (codex-acp) usable before it has an entry here.
 *
 * Labels live in the `settings` catalog so they stay translatable; the key is
 * carried here rather than the copy.
 */

/** The alias rows the settings picker offers, in the order it offers them. */
export const ACP_SELECTABLE_MODELS = [
  { value: "default", labelKey: "codingAgentsCard.modelOptions.default" },
  { value: "sonnet", labelKey: "codingAgentsCard.modelOptions.sonnet" },
  { value: "opus", labelKey: "codingAgentsCard.modelOptions.opus" },
  { value: "haiku", labelKey: "codingAgentsCard.modelOptions.haiku" },
  { value: "fable", labelKey: "codingAgentsCard.modelOptions.fable" },
  { value: "best", labelKey: "codingAgentsCard.modelOptions.best" },
  { value: "opusplan", labelKey: "codingAgentsCard.modelOptions.opusplan" },
  { value: "sonnet[1m]", labelKey: "codingAgentsCard.modelOptions.sonnet1m" },
  { value: "opus[1m]", labelKey: "codingAgentsCard.modelOptions.opus1m" },
  { value: "fable[1m]", labelKey: "codingAgentsCard.modelOptions.fable1m" },
] as const;

type AcpSelectableModelOption = (typeof ACP_SELECTABLE_MODELS)[number];

type AcpSelectableModel = AcpSelectableModelOption["value"];

/**
 * Whether a stored value is one of the rows above.
 *
 * `false` is not an error: it means the card renders the value in its custom
 * text input instead of silently dropping a setting it cannot list.
 */
export function isAcpSelectableModel(
  value: string | null | undefined,
): value is AcpSelectableModel {
  return ACP_SELECTABLE_MODELS.some((option) => option.value === value);
}
