/**
 * Writing style extraction from any message corpus.
 *
 * Takes Message[] from any platform, extracts writing style patterns
 * (tone, emoji usage, formality, abbreviations), and returns StylePattern[]
 * for memory storage.
 */

import { getConfiguredProvider } from "../providers/provider-send-message.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import { truncate } from "../util/truncate.js";
import type { Message as ProviderMessage } from "./provider-types.js";

export interface StylePattern {
  aspect: string;
  summary: string;
  importance: number;
  examples?: string[];
}

export interface ContactObservation {
  name: string;
  email: string;
  toneNote: string;
}

export interface StyleAnalysisResult {
  stylePatterns: StylePattern[];
  contactObservations: ContactObservation[];
}

const STYLE_EXTRACTION_SYSTEM_PROMPT = `You are a communication style analyst. Given a corpus of the user's sent messages, extract consistent patterns in their writing style.

Analyze these aspects:
- tone: Emotional register — warm, formal, casual, direct, enthusiastic, reserved
- greetings: How messages typically open (e.g., "Hi [name]," vs "Hey," vs no greeting)
- sign-offs: How messages typically close (e.g., "Best," vs "Thanks," vs "Cheers,")
- structure: Paragraph length, use of lists/bullets, typical message length
- vocabulary: Use of contractions, jargon, hedging language, exclamation marks
- formality_adaptation: How style shifts between different recipients (e.g., more formal with external contacts)

For each pattern you identify, provide:
- aspect: Which aspect this covers (tone, greetings, sign-offs, structure, vocabulary, formality_adaptation)
- summary: A concise description of the pattern (1-2 sentences, max 60 words)
- importance: How consistent/strong this pattern is (0.55-0.85)
- examples: 1-2 brief illustrative quotes from the messages

Also identify recurring contacts (people appearing in 3+ messages) and note how the user's tone shifts for them.

You MUST respond using the \`store_style_analysis\` tool. Do not respond with text.`;

const storeStyleAnalysisTool: ToolDefinition = {
  name: "store_style_analysis",
  description:
    "Store extracted writing style patterns and relationship observations",
  input_schema: {
    type: "object",
    properties: {
      style_patterns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            aspect: {
              type: "string",
              enum: [
                "tone",
                "greetings",
                "sign-offs",
                "structure",
                "vocabulary",
                "formality_adaptation",
              ],
            },
            summary: { type: "string" },
            importance: { type: "number" },
            examples: { type: "array", items: { type: "string" } },
          },
          required: ["aspect", "summary", "importance"],
        },
      },
      contact_observations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
            tone_note: { type: "string" },
          },
          required: ["name", "email", "tone_note"],
        },
      },
    },
    required: ["style_patterns"],
  },
};

/**
 * Build a text corpus from provider messages for LLM analysis.
 * Truncates individual messages to keep overall size manageable.
 */
function buildCorpus(messages: ProviderMessage[]): string[] {
  const entries: string[] = [];
  for (const msg of messages) {
    if (!msg.text.trim()) continue;
    const to = msg.conversationId;
    const truncatedBody = truncate(msg.text, 500, "");
    entries.push(`To: ${to}\n\n${truncatedBody}`);
  }
  return entries;
}

/**
 * Extract writing style patterns from a corpus of messages using an LLM.
 * Platform-agnostic — works with messages from any messaging provider.
 */
export async function extractStylePatterns(
  messages: ProviderMessage[],
): Promise<StyleAnalysisResult> {
  const corpusEntries = buildCorpus(messages);
  if (corpusEntries.length === 0) {
    return { stylePatterns: [], contactObservations: [] };
  }

  const corpus = corpusEntries
    .map((e, i) => `--- Message ${i + 1} ---\n${e}`)
    .join("\n\n");

  const provider = await getConfiguredProvider();
  if (!provider) {
    return { stylePatterns: [], contactObservations: [] };
  }
  const promptMessages: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Analyze these ${corpusEntries.length} sent messages for writing style patterns:\n\n${corpus}`,
        },
      ],
    },
  ];

  const response = await provider.sendMessage(
    promptMessages,
    [storeStyleAnalysisTool],
    STYLE_EXTRACTION_SYSTEM_PROMPT,
    { signal: AbortSignal.timeout(30_000) },
  );

  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    return { stylePatterns: [], contactObservations: [] };
  }

  const result = toolBlock.input as {
    style_patterns?: Array<{
      aspect: string;
      summary: string;
      importance: number;
      examples?: string[];
    }>;
    contact_observations?: Array<{
      name: string;
      email: string;
      tone_note: string;
    }>;
  };

  const stylePatterns: StylePattern[] = (result.style_patterns ?? []).map(
    (p) => ({
      aspect: p.aspect,
      summary: truncate(p.summary, 500, ""),
      importance: p.importance,
      examples: p.examples,
    }),
  );

  const contactObservations: ContactObservation[] = (
    result.contact_observations ?? []
  ).map((c) => ({
    name: c.name,
    email: c.email,
    toneNote: c.tone_note,
  }));

  return { stylePatterns, contactObservations };
}
