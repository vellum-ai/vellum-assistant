import { randomUUID } from "node:crypto";

import { z } from "zod";

import { getConfiguredProvider } from "../providers/provider-send-message.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ToolDefinition,
  ToolResultContent,
  ToolUseContent,
} from "../providers/types.js";
import { webFetchTool } from "../tools/network/web-fetch.js";
import { webSearchTool } from "../tools/network/web-search.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../tools/types.js";
import { getWorkspaceDir } from "../util/platform.js";
import type { RadioAdvanceReason, RadioTrack } from "./types.js";

const ALLOWED_WEB_TOOL_NAMES = new Set(["web_search", "web_fetch"]);
const MAX_PROVIDER_CALLS = 3;

const radioDjResponseSchema = z
  .object({
    nextTrackId: z.string().min(1),
    djText: z
      .string()
      .trim()
      .min(1)
      .refine((text) => countWords(text) <= 55, {
        message: "DJ text must be 55 words or fewer",
      }),
  })
  .strict();

const RADIO_DJ_SYSTEM_PROMPT = [
  "You are a whimsical but concise assistant radio DJ.",
  "Choose exactly one nextTrackId from the provided candidates.",
  "Write one spoken DJ break under 55 words.",
  'return JSON only: { "nextTrackId": string, "djText": string }.',
  "Use web_search or web_fetch only when timely context would improve the break.",
].join(" ");

export type RadioDjPlannerErrorCode =
  | "provider_unavailable"
  | "malformed_response"
  | "invalid_track_id"
  | "tool_loop_exhausted";

export class RadioDjPlannerError extends Error {
  constructor(
    public readonly code: RadioDjPlannerErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RadioDjPlannerError";
  }
}

export interface PlanRadioDjBreakParams {
  reason: RadioAdvanceReason;
  currentTrackId?: string;
  recentTrackIds?: readonly string[];
  trackCandidates: readonly RadioTrack[];
  locale?: string;
  signal?: AbortSignal;
}

export interface PlannedRadioDjBreak {
  nextTrackId: string;
  nextTrack: RadioTrack;
  djText: string;
}

type RadioDjExecutableTool = Pick<
  Tool,
  "name" | "description" | "input_schema" | "execute"
>;

export interface PlanRadioDjBreakDeps {
  getConfiguredProvider?: typeof getConfiguredProvider;
  webSearchTool?: RadioDjExecutableTool;
  webFetchTool?: RadioDjExecutableTool;
  getWorkspaceDir?: typeof getWorkspaceDir;
  createRequestId?: () => string;
}

export async function planRadioDjBreak(
  params: PlanRadioDjBreakParams,
  deps: PlanRadioDjBreakDeps = {},
): Promise<PlannedRadioDjBreak> {
  const resolveProvider = deps.getConfiguredProvider ?? getConfiguredProvider;
  const provider = await resolveProvider("radioDj");
  if (!provider) {
    throw new RadioDjPlannerError(
      "provider_unavailable",
      "Radio DJ provider is not configured.",
    );
  }

  const candidateById = new Map(
    params.trackCandidates.map((track) => [track.id, track]),
  );
  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: buildUserPrompt(params) }],
    },
  ];
  const searchTool = deps.webSearchTool ?? webSearchTool;
  const fetchTool = deps.webFetchTool ?? webFetchTool;
  const tools = [
    toolDefinitionFromTool(searchTool),
    sanitizeWebFetchDefinition(toolDefinitionFromTool(fetchTool)),
  ];
  const requestId = deps.createRequestId?.() ?? `radio-dj-${randomUUID()}`;
  const toolContext: ToolContext = {
    conversationId: "radio",
    workingDir: (deps.getWorkspaceDir ?? getWorkspaceDir)(),
    requestId,
    signal: params.signal,
    allowedToolNames: new Set(ALLOWED_WEB_TOOL_NAMES),
    trustClass: "guardian",
    executionChannel: "vellum",
  };

  for (let attempt = 0; attempt < MAX_PROVIDER_CALLS; attempt++) {
    const response = await sendRadioDjMessage(
      provider,
      messages,
      tools,
      params.signal,
    );
    const toolUses = response.content.filter(
      (block): block is ToolUseContent => block.type === "tool_use",
    );

    if (toolUses.length > 0) {
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: await Promise.all(
          toolUses.map((toolUse) =>
            executeToolUse(toolUse, {
              searchTool,
              fetchTool,
              toolContext,
            }),
          ),
        ),
      });
      continue;
    }

    const finalText = extractFinalText(response.content);
    if (finalText) {
      return parseRadioDjResponse(finalText, candidateById);
    }
  }

  throw new RadioDjPlannerError(
    "tool_loop_exhausted",
    "Radio DJ did not return a final break within the tool loop.",
  );
}

async function sendRadioDjMessage(
  provider: Provider,
  messages: Message[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
) {
  return await provider.sendMessage(messages, {
    tools,
    systemPrompt: RADIO_DJ_SYSTEM_PROMPT,
    config: { callSite: "radioDj" },
    signal,
  });
}

function buildUserPrompt(params: PlanRadioDjBreakParams): string {
  return JSON.stringify({
    task: "Plan the next assistant radio DJ break.",
    reason: params.reason,
    currentTrackId: params.currentTrackId ?? null,
    recentTrackIds: params.recentTrackIds ?? [],
    locale: params.locale ?? null,
    trackCandidates: params.trackCandidates.map((track) => ({
      nextTrackId: track.id,
      title: track.title,
      artist: track.artist,
      durationMs: track.durationMs,
      sourceLabel: track.sourceLabel,
    })),
  });
}

async function executeToolUse(
  toolUse: ToolUseContent,
  deps: {
    searchTool: RadioDjExecutableTool;
    fetchTool: RadioDjExecutableTool;
    toolContext: ToolContext;
  },
): Promise<ToolResultContent> {
  if (
    toolUse.name === "web_fetch" &&
    toolUse.input.allow_private_network === true
  ) {
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content:
        "web_fetch allow_private_network is not available to the radio DJ.",
      is_error: true,
    };
  }

  const tool = toolForName(toolUse.name, deps);
  if (!tool) {
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: `Tool "${toolUse.name}" is not available to the radio DJ. Allowed tools: web_search, web_fetch.`,
      is_error: true,
    };
  }

  try {
    const result = await tool.execute(toolUse.input, deps.toolContext);
    return toolResultFromExecution(toolUse.id, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: `Tool "${toolUse.name}" failed: ${message}`,
      is_error: true,
    };
  }
}

function toolForName(
  name: string,
  deps: {
    searchTool: RadioDjExecutableTool;
    fetchTool: RadioDjExecutableTool;
  },
): RadioDjExecutableTool | null {
  if (name === "web_search") return deps.searchTool;
  if (name === "web_fetch") return deps.fetchTool;
  return null;
}

function cloneToolDefinition(definition: ToolDefinition): ToolDefinition {
  return structuredClone(definition) as ToolDefinition;
}

function toolDefinitionFromTool(tool: RadioDjExecutableTool): ToolDefinition {
  return cloneToolDefinition({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  });
}

function sanitizeWebFetchDefinition(
  definition: ToolDefinition,
): ToolDefinition {
  const cloned = cloneToolDefinition(definition);
  const inputSchema = cloned.input_schema;
  if (!isRecord(inputSchema)) return cloned;

  const properties = inputSchema.properties;
  if (!isRecord(properties)) return cloned;

  const { allow_private_network: _allowPrivateNetwork, ...safeProperties } =
    properties;
  inputSchema.properties = safeProperties;
  return cloned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolResultFromExecution(
  toolUseId: string,
  result: ToolExecutionResult,
): ToolResultContent {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: result.content,
    ...(result.isError ? { is_error: true } : {}),
    ...(result.contentBlocks ? { contentBlocks: result.contentBlocks } : {}),
  };
}

function extractFinalText(content: readonly ContentBlock[]): string | null {
  const text = content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => {
      return block.type === "text";
    })
    .map((block) => block.text)
    .join("")
    .trim();

  return text.length > 0 ? text : null;
}

function parseRadioDjResponse(
  text: string,
  candidateById: ReadonlyMap<string, RadioTrack>,
): PlannedRadioDjBreak {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (cause) {
    throw new RadioDjPlannerError(
      "malformed_response",
      "Radio DJ returned malformed JSON.",
      { cause },
    );
  }

  const parsed = radioDjResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new RadioDjPlannerError(
      "malformed_response",
      "Radio DJ returned a malformed response shape.",
      { cause: parsed.error },
    );
  }

  const nextTrack = candidateById.get(parsed.data.nextTrackId);
  if (!nextTrack) {
    throw new RadioDjPlannerError(
      "invalid_track_id",
      `Radio DJ selected unknown track id "${parsed.data.nextTrackId}".`,
    );
  }

  return {
    nextTrackId: parsed.data.nextTrackId,
    nextTrack,
    djText: parsed.data.djText,
  };
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
