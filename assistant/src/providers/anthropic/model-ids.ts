/**
 * Claude model identifiers as the providers that serve them spell them:
 * Anthropic's native model-first form (`claude-opus-4-7`, optionally with a
 * `-YYYYMMDD` snapshot suffix), the OpenAI-compatible gateways' vendor-prefixed
 * dotted form (`anthropic/claude-opus-4.7`), and the version-first form some
 * gateway responses report (`claude-4-7-opus-20260416`).
 */

/** Whether `model` names a Claude model in any of the forms above. */
export function isAnthropicModelId(model: string): boolean {
  return model.startsWith("anthropic/") || model.startsWith("claude-");
}

/**
 * Normalize an OpenRouter-style Anthropic model ID for lookup against the
 * Anthropic catalog: strip the `anthropic/` prefix, convert OpenRouter's
 * dot-separated version tokens (`claude-opus-4.6`) to the dash form Anthropic
 * uses natively (`claude-opus-4-6`), and swap OpenRouter's version-first
 * response form (`claude-4-7-opus-20260416`) into Anthropic's model-first
 * catalog form (`claude-opus-4-7-20260416`) so the prefix match succeeds.
 */
export function normalizeAnthropicModelId(model: string): string {
  const bare = model.startsWith("anthropic/")
    ? model.slice("anthropic/".length)
    : model;
  const dashed = bare.replace(/\./g, "-");
  const versionFirst = dashed.match(
    /^claude-(\d+(?:-\d+)*)-(opus|sonnet|haiku)(-.+)?$/,
  );
  if (versionFirst) {
    const [, version, family, suffix] = versionFirst;
    return `claude-${family}-${version}${suffix ?? ""}`;
  }
  return dashed;
}

export interface ClaudeModelGeneration {
  major: number;
  minor: number;
}

/**
 * The Claude generation a model id names: `claude-opus-4-7` is 4.7 and
 * `claude-sonnet-5` is 5.0, read from the normalized id with any snapshot
 * date removed. Null for ids that are not Claude models or carry no
 * `claude-<family>-<major>[-<minor>]` version.
 */
export function claudeModelGeneration(
  model: string,
): ClaudeModelGeneration | null {
  const match = normalizeAnthropicModelId(model)
    .replace(/-\d{8}$/, "")
    .match(/^claude-[a-z]+-(\d+)(?:-(\d+))?$/);
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2] ?? 0) };
}
