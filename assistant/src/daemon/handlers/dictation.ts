import * as net from 'node:net';
import { getConfig } from '../../config/loader.js';
import { getFailoverProvider, listProviders } from '../../providers/registry.js';
import type { DictationRequest } from '../ipc-protocol.js';
import { log, defineHandlers, type HandlerContext } from './shared.js';

// Action verbs that signal the user wants a full agent session rather than inline text
const ACTION_VERBS = ['slack', 'email', 'send', 'create', 'open', 'search', 'find'];

const MAX_WINDOW_TITLE_LENGTH = 100;

/** Sanitize window title to mitigate prompt injection from attacker-controlled titles (e.g. browser tabs, Slack conversations). */
function sanitizeWindowTitle(title: string | undefined): string {
  if (!title) return '';
  return title.slice(0, MAX_WINDOW_TITLE_LENGTH);
}

/** Build a delimited app metadata block so the LLM treats it as contextual data, not instructions. */
function buildAppMetadataBlock(msg: DictationRequest): string {
  const windowTitle = sanitizeWindowTitle(msg.context.windowTitle);
  return [
    '<app_metadata>',
    `App: ${msg.context.appName} (${msg.context.bundleIdentifier})`,
    `Window: ${windowTitle}`,
    '</app_metadata>',
  ].join('\n');
}

type DictationMode = 'dictation' | 'command' | 'action';

function detectMode(msg: DictationRequest): DictationMode {
  // Command mode: selected text present — treat transcription as a transformation instruction
  if (msg.context.selectedText && msg.context.selectedText.trim().length > 0) {
    return 'command';
  }

  // Action mode: transcription starts with an action verb
  const firstWord = msg.transcription.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (ACTION_VERBS.includes(firstWord)) {
    return 'action';
  }

  // Dictation mode: cursor is in a text field with no selection — clean up for typing
  if (msg.context.cursorInTextField) {
    return 'dictation';
  }

  // Default to action when not in a text field and no selection
  return 'action';
}

function buildDictationPrompt(msg: DictationRequest): string {
  return [
    'You are a dictation assistant. Clean up the following speech transcription for direct insertion into a text field.',
    '',
    '## Rules',
    '- Fix grammar, punctuation, and capitalization',
    '- Remove filler words (um, uh, like, you know)',
    "- Maintain the speaker's intent and meaning",
    '- Do NOT add explanations or commentary',
    '- Return ONLY the cleaned text, nothing else',
    '',
    '## Tone Adaptation',
    'Adapt your output tone based on the active application:',
    '- Email apps (Gmail, Mail): Professional but warm. Use proper greetings and sign-offs if appropriate.',
    '- Slack: Casual and conversational. Match typical chat style.',
    '- Code editors (VS Code, Xcode): Technical and concise. Code comments style.',
    '- Terminal: Command-like, terse.',
    '- Messages/iMessage: Very casual, texting style. Short sentences.',
    '- Notes/Docs: Neutral, clear writing.',
    '- Default: Match the user\'s natural voice.',
    '',
    '## Context Clues',
    '- Window title may contain recipient name (Slack DMs, email compose)',
    '- If you can identify a recipient, adapt formality to the apparent relationship',
    '- Maintain the user\'s natural voice — don\'t over-formalize casual speech',
    '- The user\'s writing patterns and preferences may be available from memory context — follow those when present',
    '',
    buildAppMetadataBlock(msg),
  ].join('\n');
}

function buildCommandPrompt(msg: DictationRequest): string {
  return [
    'You are a text transformation assistant. The user has selected text and given a voice command to transform it.',
    '',
    '## Rules',
    '- Apply the instruction to the selected text',
    '- Return ONLY the transformed text, nothing else',
    '- Do NOT add explanations or commentary',
    '',
    '## Tone Adaptation',
    'Match the tone to the active application context:',
    '- Email apps (Gmail, Mail): Professional but warm.',
    '- Slack: Casual and conversational.',
    '- Code editors (VS Code, Xcode): Technical and concise.',
    '- Terminal: Command-like, terse.',
    '- Messages/iMessage: Very casual, texting style.',
    '- Notes/Docs: Neutral, clear writing.',
    '- Default: Match the user\'s natural voice.',
    '',
    '## Context Clues',
    '- Window title may contain recipient name (Slack DMs, email compose)',
    '- If you can identify a recipient, adapt formality to the apparent relationship',
    '- Maintain the user\'s natural voice — don\'t over-formalize casual speech',
    '- The user\'s writing patterns and preferences may be available from memory context — follow those when present',
    '',
    buildAppMetadataBlock(msg),
    '',
    'Selected text:',
    msg.context.selectedText ?? '',
    '',
    `Instruction: ${msg.transcription}`,
  ].join('\n');
}

export async function handleDictationRequest(
  msg: DictationRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const mode = detectMode(msg);
  log.info({ mode, transcriptionLength: msg.transcription.length }, 'Dictation request received');

  // Action mode: return immediately — the client will route to a full agent session
  if (mode === 'action') {
    ctx.send(socket, {
      type: 'dictation_response',
      text: msg.transcription,
      mode: 'action',
      actionPlan: `User wants to: ${msg.transcription}`,
    });
    return;
  }

  // Dictation / command mode: make a single-turn LLM call for text cleanup or transformation
  const systemPrompt = mode === 'dictation'
    ? buildDictationPrompt(msg)
    : buildCommandPrompt(msg);

  const userText = mode === 'dictation'
    ? msg.transcription
    : msg.transcription; // command prompt already embeds the selected text and instruction

  try {
    const config = getConfig();
    if (!listProviders().includes(config.provider)) {
      log.warn({ provider: config.provider }, 'Dictation: no provider available, returning raw transcription');
      const fallbackText = mode === 'command' ? (msg.context.selectedText ?? msg.transcription) : msg.transcription;
      ctx.send(socket, { type: 'dictation_response', text: fallbackText, mode });
      return;
    }

    const provider = getFailoverProvider(config.provider, config.providerOrder);
    const response = await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      [], // no tools
      systemPrompt,
      { config: { max_tokens: 1024 } },
    );

    const textBlock = response.content.find((b) => b.type === 'text');
    const inlineFallback = mode === 'command' ? (msg.context.selectedText ?? msg.transcription) : msg.transcription;
    const cleanedText = textBlock && 'text' in textBlock ? textBlock.text.trim() : inlineFallback;

    ctx.send(socket, { type: 'dictation_response', text: cleanedText, mode });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Dictation LLM call failed, returning raw transcription');
    const fallbackText = mode === 'command' ? (msg.context.selectedText ?? msg.transcription) : msg.transcription;
    ctx.send(socket, { type: 'dictation_response', text: fallbackText, mode });
    ctx.send(socket, { type: 'error', message: `Dictation cleanup failed: ${message}` });
  }
}

export const dictationHandlers = defineHandlers({
  dictation_request: handleDictationRequest,
});
