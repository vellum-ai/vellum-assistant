/**
 * Factory for creating an ApprovalCopyGenerator backed by the provider
 * registry. Called from daemon lifecycle wiring to inject the real
 * provider-backed implementation into the runtime HTTP server.
 */
import { getConfig } from '../config/loader.js';
import { getFailoverProvider, listProviders } from '../providers/registry.js';
import type { ApprovalCopyGenerator } from './http-types.js';
import type {
  ApprovalMessageContext,
  ComposeApprovalMessageGenerativeOptions,
} from './approval-message-composer.js';

const APPROVAL_COPY_TIMEOUT_MS = 4_000;
const APPROVAL_COPY_MAX_TOKENS = 180;
const APPROVAL_COPY_SYSTEM_PROMPT =
  'You are an assistant writing one user-facing message about permissions/approval state. '
  + 'Keep it concise, natural, and actionable. Preserve factual details exactly. '
  + 'Do not mention internal systems, scenario IDs, or policy engine details. '
  + 'Return plain text only.';

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function includesRequiredKeywords(text: string, requiredKeywords: string[] | undefined): boolean {
  if (!requiredKeywords || requiredKeywords.length === 0) return true;
  return requiredKeywords.every((keyword) => {
    const re = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i');
    return re.test(text);
  });
}

function buildGenerationPrompt(
  context: ApprovalMessageContext,
  fallbackText: string,
  requiredKeywords: string[] | undefined,
): string {
  const keywordClause = requiredKeywords && requiredKeywords.length > 0
    ? `Required words to include (as standalone words): ${requiredKeywords.join(', ')}.\n`
    : '';
  return [
    'Rewrite the following approval/guardian message as a natural assistant reply to the user.',
    'Keep the same concrete facts and next-step guidance.',
    keywordClause,
    `Context JSON: ${JSON.stringify(context)}`,
    `Fallback message: ${fallbackText}`,
  ].filter(Boolean).join('\n\n');
}

/**
 * Create an ApprovalCopyGenerator that resolves the active provider from the
 * registry and calls `provider.sendMessage(...)` to generate approval copy.
 *
 * Returns `null` when no provider is available or generation fails, so the
 * caller falls back to deterministic templates.
 */
export function createApprovalCopyGenerator(): ApprovalCopyGenerator {
  return async (
    context: ApprovalMessageContext,
    fallbackText: string,
    options: ComposeApprovalMessageGenerativeOptions,
  ): Promise<string | null> => {
    const config = getConfig();
    if (!listProviders().includes(config.provider)) {
      return null;
    }

    const provider = getFailoverProvider(config.provider, config.providerOrder);
    const requiredKeywords = options.requiredKeywords?.map((kw) => kw.trim()).filter((kw) => kw.length > 0);
    const prompt = buildGenerationPrompt(context, fallbackText, requiredKeywords);

    const response = await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      [],
      APPROVAL_COPY_SYSTEM_PROMPT,
      {
        config: {
          max_tokens: options.maxTokens ?? APPROVAL_COPY_MAX_TOKENS,
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? APPROVAL_COPY_TIMEOUT_MS),
      },
    );

    const block = response.content.find((entry) => entry.type === 'text');
    const text = block && 'text' in block ? block.text.trim() : '';
    if (!text) return null;

    const cleaned = text
      .replace(/^["'`]+/, '')
      .replace(/["'`]+$/, '')
      .trim();
    if (!cleaned) return null;
    if (!includesRequiredKeywords(cleaned, requiredKeywords)) return null;

    return cleaned;
  };
}
