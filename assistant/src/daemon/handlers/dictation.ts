import * as net from 'node:net';

import { createTimeout, extractToolUse, getConfiguredProvider, userMessage } from '../../providers/provider-send-message.js';
import { resolveProfile } from '../dictation-profile-store.js';
import { applyDictionary, expandSnippets } from '../dictation-text-processing.js';
import type { DictationRequest } from '../ipc-protocol.js';
import { defineHandlers, type HandlerContext, log } from './shared.js';

// Action verbs for fast heuristic fallback (used when LLM classifier is unavailable)
const ACTION_VERBS = ['slack', 'email', 'send', 'create', 'open', 'search', 'find', 'message', 'text', 'schedule', 'remind', 'launch', 'navigate'];

const DICTATION_CLASSIFICATION_TIMEOUT_MS = 5000;

const MAX_WINDOW_TITLE_LENGTH = 100;

/** Sanitize window title to mitigate prompt injection from attacker-controlled titles (e.g. browser tabs, Slack conversations). */
function sanitizeWindowTitle(title: string | undefined): string {
  if (!title) return '';
  return title
    .replace(/[<>]/g, '') // strip angle brackets to prevent tag injection
    .slice(0, MAX_WINDOW_TITLE_LENGTH);
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

/** Fast heuristic fallback — used when LLM classifier is unavailable or fails. */
export function detectDictationModeHeuristic(msg: DictationRequest): DictationMode {
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

  return 'dictation';
}

/** Classify dictation mode using Haiku, falling back to heuristic. */
export async function detectDictationMode(msg: DictationRequest): Promise<DictationMode> {
  // Command mode is deterministic — no need for LLM
  if (msg.context.selectedText && msg.context.selectedText.trim().length > 0) {
    return 'command';
  }

  const provider = getConfiguredProvider();
  if (!provider) {
    log.warn('No provider for dictation classification, using heuristic');
    return detectDictationModeHeuristic(msg);
  }

  try {
    const { signal, cleanup } = createTimeout(DICTATION_CLASSIFICATION_TIMEOUT_MS);
    try {
      const contextInfo = [
        `App: ${msg.context.appName} (${msg.context.bundleIdentifier})`,
        msg.context.windowTitle ? `Window: ${msg.context.windowTitle}` : '',
        `Cursor in text field: ${msg.context.cursorInTextField ? 'yes' : 'no'}`,
      ].filter(Boolean).join('\n');

      const response = await provider.sendMessage(
        [userMessage(`Transcription: "${msg.transcription}"\n\nContext:\n${contextInfo}`)],
        [{
          name: 'classify_dictation',
          description: 'Classify whether voice input is dictation or an action command',
          input_schema: {
            type: 'object' as const,
            properties: {
              mode: {
                type: 'string',
                enum: ['dictation', 'action'],
                description: 'dictation = user wants text inserted/cleaned up for typing. action = user wants the assistant to perform a task (send a message, open an app, search, navigate, control something).',
              },
              reasoning: {
                type: 'string',
                description: 'Brief reasoning for the classification',
              },
            },
            required: ['mode', 'reasoning'],
          },
        }],
        [
          'You classify voice transcriptions as either "dictation" (text to insert) or "action" (task for an assistant to execute).',
          '',
          'DICTATION examples: "Hey how are you doing", "I think we should move forward with the proposal", "Dear team comma please review the attached document"',
          'ACTION examples: "Message Aaron on Slack saying hey what\'s up", "Send an email to the team about the meeting", "Open Spotify and play my playlist", "Search for flights to Denver", "Create a new document in Google Docs"',
          '',
          'Key signals for ACTION: the user is addressing an assistant and asking it to DO something (send, message, open, search, create, schedule, etc.)',
          'Key signals for DICTATION: the user is composing text content that should be typed out as-is',
          '',
          'Context is provided — if the cursor is in a text field, lean toward dictation unless the intent to command is clear.',
        ].join('\n'),
        {
          config: {
            modelIntent: 'latency-optimized',
            max_tokens: 128,
            tool_choice: { type: 'tool' as const, name: 'classify_dictation' },
          },
          signal,
        },
      );
      cleanup();

      const toolBlock = extractToolUse(response);
      if (toolBlock) {
        const input = toolBlock.input as { mode?: string; reasoning?: string };
        const mode = input.mode === 'action' ? 'action' : 'dictation';
        log.info({ mode, reasoning: input.reasoning }, 'LLM dictation classification');
        return mode;
      }

      log.warn('No tool_use block in dictation classification, using heuristic');
      return detectDictationModeHeuristic(msg);
    } finally {
      cleanup();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'LLM dictation classification failed, using heuristic');
    return detectDictationModeHeuristic(msg);
  }
}

function buildDictationPrompt(msg: DictationRequest, stylePrompt?: string): string {
  const sections = [
    'You are a dictation assistant. Clean up the following speech transcription for direct insertion into a text field.',
    '',
    '## Rules',
    '- Fix grammar, punctuation, and capitalization',
    '- Remove filler words (um, uh, like, you know)',
    '- Rewrite vague or hedging language ("so yeah probably", "I guess maybe") into clear, confident statements',
    "- Maintain the speaker's intent and meaning",
    '- Do NOT add explanations or commentary',
    '- Return ONLY the cleaned text, nothing else',
  ];

  if (stylePrompt) {
    sections.push(
      '',
      '## User Style (HIGHEST PRIORITY)',
      'The user has configured these style preferences. They OVERRIDE the default tone adaptation below.',
      'Follow these instructions precisely — they reflect the user\'s personal writing voice and preferences.',
      '',
      stylePrompt,
    );
  }

  sections.push(
    '',
    '## Tone Adaptation',
  );

  if (stylePrompt) {
    sections.push('Use these as fallback guidance only when the User Style above does not cover a specific aspect:');
  } else {
    sections.push('Adapt your output tone based on the active application:');
  }

  sections.push(
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
  );

  return sections.join('\n');
}

function buildCommandPrompt(msg: DictationRequest, stylePrompt?: string): string {
  const sections = [
    'You are a text transformation assistant. The user has selected text and given a voice command to transform it.',
    '',
    '## Rules',
    '- Apply the instruction to the selected text',
    '- Return ONLY the transformed text, nothing else',
    '- Do NOT add explanations or commentary',
  ];

  if (stylePrompt) {
    sections.push(
      '',
      '## User Style (HIGHEST PRIORITY)',
      'The user has configured these style preferences. They OVERRIDE the default tone adaptation below.',
      'Follow these instructions precisely — they reflect the user\'s personal writing voice and preferences.',
      '',
      stylePrompt,
    );
  }

  sections.push(
    '',
    '## Tone Adaptation',
  );

  if (stylePrompt) {
    sections.push('Use these as fallback guidance only when the User Style above does not cover a specific aspect:');
  } else {
    sections.push('Match the tone to the active application context:');
  }

  sections.push(
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
  );

  return sections.join('\n');
}

export async function handleDictationRequest(
  msg: DictationRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const mode = await detectDictationMode(msg);
  log.info({ mode, transcriptionLength: msg.transcription.length }, 'Dictation request received');

  // Resolve profile for all modes (metadata is included in response)
  const resolution = resolveProfile(
    msg.context.bundleIdentifier,
    msg.context.appName,
    msg.profileId,
  );
  const { profile, source: profileSource } = resolution;
  log.info({ profileId: profile.id, profileSource }, 'Resolved dictation profile');

  const profileMeta = {
    resolvedProfileId: profile.id,
    profileSource,
  };

  // Action mode: return immediately — the client will route to a full agent session
  if (mode === 'action') {
    ctx.send(socket, {
      type: 'dictation_response',
      text: msg.transcription,
      mode: 'action',
      actionPlan: `User wants to: ${msg.transcription}`,
      ...profileMeta,
    });
    return;
  }

  // Pre-LLM snippet expansion (dictation mode only)
  const transcription = mode === 'dictation'
    ? expandSnippets(msg.transcription, profile.snippets)
    : msg.transcription;

  // Dictation / command mode: make a single-turn LLM call for text cleanup or transformation
  const stylePrompt = profile.stylePrompt || undefined;
  const systemPrompt = mode === 'dictation'
    ? buildDictationPrompt(msg, stylePrompt)
    : buildCommandPrompt(msg, stylePrompt);

  const userText = transcription;

  try {
    const provider = getConfiguredProvider();
    if (!provider) {
      log.warn('Dictation: no provider available, returning raw transcription');
      const fallbackText = mode === 'command' ? (msg.context.selectedText ?? transcription) : transcription;
      const normalizedText = applyDictionary(fallbackText, profile.dictionary);
      ctx.send(socket, { type: 'dictation_response', text: normalizedText, mode, ...profileMeta });
      return;
    }

    const response = await provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      [], // no tools
      systemPrompt,
      { config: { max_tokens: 1024 } },
    );

    const textBlock = response.content.find((b) => b.type === 'text');
    const inlineFallback = mode === 'command' ? (msg.context.selectedText ?? transcription) : transcription;
    const cleanedText = textBlock && 'text' in textBlock ? textBlock.text.trim() : inlineFallback;

    // Post-LLM dictionary normalization
    const normalizedText = applyDictionary(cleanedText, profile.dictionary);

    ctx.send(socket, { type: 'dictation_response', text: normalizedText, mode, ...profileMeta });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Dictation LLM call failed, returning raw transcription');
    const fallbackText = mode === 'command' ? (msg.context.selectedText ?? transcription) : transcription;
    const normalizedText = applyDictionary(fallbackText, profile.dictionary);
    ctx.send(socket, { type: 'dictation_response', text: normalizedText, mode, ...profileMeta });
    ctx.send(socket, { type: 'error', message: `Dictation cleanup failed: ${message}` });
  }
}

export const dictationHandlers = defineHandlers({
  dictation_request: handleDictationRequest,
});
