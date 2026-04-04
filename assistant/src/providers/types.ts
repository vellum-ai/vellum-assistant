export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface FileContent {
  type: "file";
  source: {
    type: "base64";
    media_type: string;
    data: string;
    filename: string;
  };
  extracted_text?: string;
}

/**
 * Persisted form of a user image attachment. The binary payload lives in the
 * attachment store; only the attachment ID and media type are kept inline.
 * Hydrated to a full `ImageContent` block (with base64 `data`) right before
 * each provider call. Must never be sent to a provider as-is.
 */
export interface AttachmentBackedImageBlock {
  type: "image_ref";
  source: {
    attachment_id: string;
    media_type: string;
  };
  /** File size in bytes, used for token estimation without reading the file. */
  size_bytes?: number;
}

/**
 * Persisted form of a user file attachment. The binary payload lives in the
 * attachment store; only the attachment ID and metadata are kept inline.
 * Hydrated to a full `FileContent` block (with base64 `data`) right before
 * each provider call. Must never be sent to a provider as-is.
 */
export interface AttachmentBackedFileBlock {
  type: "file_ref";
  source: {
    attachment_id: string;
    media_type: string;
    filename: string;
  };
  extracted_text?: string;
  /** File size in bytes, used for token estimation without reading the file. */
  size_bytes?: number;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface RedactedThinkingContent {
  type: "redacted_thinking";
  data: string;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  /** Rich content blocks (e.g. images) to include alongside text in the tool result. */
  contentBlocks?: ContentBlock[];
}

export interface ServerToolUseContent {
  type: "server_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface WebSearchToolResultContent {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: unknown; // Opaque — encrypted_content in search results is provider-specific
}

export type ContentBlock =
  | TextContent
  | ThinkingContent
  | RedactedThinkingContent
  | ImageContent
  | FileContent
  | AttachmentBackedImageBlock
  | AttachmentBackedFileBlock
  | ToolUseContent
  | ToolResultContent
  | ServerToolUseContent
  | WebSearchToolResultContent;

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: object;
}

export type ModelIntent =
  | "latency-optimized"
  | "quality-optimized"
  | "vision-optimized";

export interface ProviderResponse {
  content: ContentBlock[];
  model: string;
  /** Provider that actually produced this response, which may differ from a wrapper provider name. */
  actualProvider?: string;
  usage: {
    /** Total input tokens (input_tokens + cache_creation + cache_read). */
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    reasoningTokens?: number;
  };
  stopReason: string;
  /** Raw JSON request body sent to the provider (for diagnostics logging). */
  rawRequest?: unknown;
  /** Raw JSON response body received from the provider (for diagnostics logging). */
  rawResponse?: unknown;
}

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_use_preview_start"; toolUseId: string; toolName: string }
  | {
      type: "input_json_delta";
      toolName: string;
      toolUseId: string;
      accumulatedJson: string;
    }
  | {
      type: "server_tool_start";
      name: string;
      toolUseId: string;
      input: Record<string, unknown>;
    }
  | { type: "server_tool_complete"; toolUseId: string; isError: boolean };

export interface SendMessageConfig {
  model?: string;
  modelIntent?: ModelIntent;
  effort?: "low" | "medium" | "high" | "max";
  speed?: "standard" | "fast";
  [key: string]: unknown;
}

export interface SendMessageOptions {
  config?: SendMessageConfig;
  onEvent?: (event: ProviderEvent) => void;
  signal?: AbortSignal;
}

export interface Provider {
  name: string;
  sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse>;
}
