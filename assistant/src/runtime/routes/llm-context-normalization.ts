export interface LlmContextNormalizationInput {
  requestPayload: unknown;
  responsePayload: unknown;
  createdAt: number;
}

export interface LlmContextSummary {
  provider: "openai" | "anthropic" | "gemini";
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  stopReason?: string;
  requestMessageCount?: number;
  requestToolCount?: number;
  responseMessageCount?: number;
  responseToolCallCount?: number;
  responsePreview?: string;
  toolCallNames?: string[];
}

export interface LlmContextSection {
  kind:
    | "system"
    | "message"
    | "settings"
    | "tool_definitions"
    | "tool_use"
    | "tool_result"
    | "function_call"
    | "function_response";
  label: string;
  role?: string;
  text?: string;
  toolName?: string;
  data?: unknown;
  language?: string;
}

export interface LlmContextNormalizationResult {
  summary?: LlmContextSummary;
  requestSections?: LlmContextSection[];
  responseSections?: LlmContextSection[];
}

interface NormalizedPayloadCandidate {
  provider: LlmContextSummary["provider"];
  summary: LlmContextSummary;
  requestSections?: LlmContextSection[];
  responseSections?: LlmContextSection[];
}

export function normalizeLlmContextPayloads(
  input: LlmContextNormalizationInput,
): LlmContextNormalizationResult {
  const requestCandidates = [
    normalizeOpenAiRequestPayload(input.requestPayload),
    normalizeAnthropicRequestPayload(input.requestPayload),
    normalizeGeminiRequestPayload(input.requestPayload),
  ].filter((candidate): candidate is NormalizedPayloadCandidate => Boolean(candidate));
  const responseCandidates = [
    normalizeOpenAiResponsePayload(input.responsePayload),
    normalizeAnthropicResponsePayload(input.responsePayload),
    normalizeGeminiResponsePayload(input.responsePayload),
  ].filter((candidate): candidate is NormalizedPayloadCandidate => Boolean(candidate));

  const requestProviders = new Set(requestCandidates.map((candidate) => candidate.provider));
  const responseProviders = new Set(
    responseCandidates.map((candidate) => candidate.provider),
  );
  const sharedProviders = [...requestProviders].filter((provider) =>
    responseProviders.has(provider),
  );

  if (sharedProviders.length > 1) {
    return {};
  }

  if (sharedProviders.length === 1) {
    const provider = sharedProviders[0] as LlmContextSummary["provider"];
    const requestCandidate = requestCandidates.find(
      (candidate) => candidate.provider === provider,
    );
    const responseCandidate = responseCandidates.find(
      (candidate) => candidate.provider === provider,
    );

    const requestSections = [
      ...(requestCandidate?.requestSections ?? []),
      ...(responseCandidate?.requestSections ?? []),
    ];
    const responseSections = [
      ...(requestCandidate?.responseSections ?? []),
      ...(responseCandidate?.responseSections ?? []),
    ];

    return {
      summary: mergeSummaryFragments(
        requestCandidate?.summary,
        responseCandidate?.summary,
      ),
      requestSections: requestSections.length > 0 ? requestSections : undefined,
      responseSections: responseSections.length > 0 ? responseSections : undefined,
    };
  }

  if (requestCandidates.length === 1 && responseCandidates.length === 0) {
    return requestCandidates[0] as LlmContextNormalizationResult;
  }

  if (responseCandidates.length === 1 && requestCandidates.length === 0) {
    return responseCandidates[0] as LlmContextNormalizationResult;
  }

  return {};
}

function normalizeOpenAiRequestPayload(
  requestPayload: unknown,
): NormalizedPayloadCandidate | null {
  const request = asRecord(requestPayload);
  if (!request) {
    return null;
  }

  const messages = asRecordArray(request.messages);
  if (!messages) {
    return null;
  }

  const requestToolNames = extractOpenAiRequestToolNames(request.tools);
  const hasOpenAiSignal =
    requestToolNames.length > 0 ||
    asString(request.tool_choice) !== undefined ||
    (request.parallel_tool_calls !== undefined &&
      typeof request.parallel_tool_calls === "boolean") ||
    messages.some((message) => Boolean(asRecordArray(message.tool_calls)));
  if (!hasOpenAiSignal) {
    return null;
  }

  const requestSections: LlmContextSection[] = [];
  for (const [index, message] of messages.entries()) {
    const role = asString(message.role) ?? "unknown";
    const messageText = extractOpenAiContentText(message.content);
    if (messageText !== undefined) {
      requestSections.push({
        kind: role === "system" ? "system" : role === "tool" ? "tool_result" : "message",
        label: buildMessageLabel(role, index + 1),
        role,
        text: messageText,
      });
    }

    for (const toolCallSection of openAiToolCallSections(
      message.tool_calls,
      "Request tool call",
    )) {
      requestSections.push(toolCallSection);
    }
  }

  if (requestToolNames.length > 0) {
    requestSections.push({
      kind: "tool_definitions",
      label: "Available tools",
      data: {
        tools: asRecordArray(request.tools) ?? request.tools,
      },
      language: "json",
    });
  }

  const requestSettings = omitRecordKeys(request, ["messages", "tools"]);
  if (hasMeaningfulRequestSettings(requestSettings)) {
    requestSections.push(structuredJsonSection("settings", "Request settings", requestSettings));
  }

  return {
    provider: "openai",
    summary: {
      provider: "openai",
      model: asString(request.model),
      inputTokens: undefined,
      outputTokens: undefined,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
      stopReason: undefined,
      requestMessageCount: messages.length,
      requestToolCount: requestToolNames.length,
      responseMessageCount: undefined,
      responseToolCallCount: undefined,
      responsePreview: undefined,
      toolCallNames: undefined,
    },
    requestSections: requestSections.length > 0 ? requestSections : undefined,
  };
}

function normalizeOpenAiResponsePayload(
  responsePayload: unknown,
): NormalizedPayloadCandidate | null {
  const response = asRecord(responsePayload);
  if (!response) {
    return null;
  }

  const choices = asRecordArray(response.choices);
  if (!choices) {
    return null;
  }

  const firstChoice = choices[0];
  const responseMessage = asRecord(firstChoice?.message);
  const responseText = extractOpenAiContentText(responseMessage?.content);
  const responseSections: LlmContextSection[] = [];
  if (responseText !== undefined) {
    responseSections.push({
      kind: "message",
      label: "Assistant response",
      role: asString(responseMessage?.role) ?? "assistant",
      text: responseText,
    });
  }
  const responseToolSections = openAiToolCallSections(
    responseMessage?.tool_calls,
    "Response tool call",
  );
  responseSections.push(...responseToolSections);

  const usage = asRecord(response.usage);
  const toolCallNames = responseToolSections
    .map((section) => section.toolName)
    .filter((name): name is string => typeof name === "string");

  return {
    provider: "openai",
    summary: {
      provider: "openai",
      model: asString(response.model),
      inputTokens: asNumber(usage?.prompt_tokens),
      outputTokens: asNumber(usage?.completion_tokens),
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
      stopReason: asString(firstChoice?.finish_reason),
      requestMessageCount: undefined,
      requestToolCount: undefined,
      responseMessageCount:
        responseText !== undefined || responseToolSections.length > 0 ? 1 : undefined,
      responseToolCallCount:
        responseToolSections.length > 0 ? responseToolSections.length : undefined,
      responsePreview: responseText ? truncateText(responseText) : undefined,
      toolCallNames: toolCallNames.length > 0 ? toolCallNames : undefined,
    },
    responseSections: responseSections.length > 0 ? responseSections : undefined,
  };
}

function normalizeAnthropicRequestPayload(
  requestPayload: unknown,
): NormalizedPayloadCandidate | null {
  const request = asRecord(requestPayload);
  if (!request) {
    return null;
  }

  const messages = asRecordArray(request.messages);
  if (!messages) {
    return null;
  }

  const requestToolNames = extractAnthropicToolNames(request.tools);
  const hasAnthropicContentSignal = messages.some((message) =>
    (asRecordArray(message.content) ?? []).some((block) => {
      const type = asString(block.type);
      return (
        type === "tool_use" ||
        type === "tool_result" ||
        type === "web_search_tool_result" ||
        type === "thinking" ||
        type === "redacted_thinking"
      );
    }),
  );
  const hasAnthropicSignal =
    request.system !== undefined ||
    requestToolNames.length > 0 ||
    Boolean(asRecord(request.tool_choice)) ||
    hasAnthropicContentSignal;
  if (!hasAnthropicSignal) {
    return null;
  }

  const requestSections: LlmContextSection[] = [];
  const systemSections = anthropicSystemSections(request.system);
  requestSections.push(...systemSections);

  for (const [index, message] of messages.entries()) {
    requestSections.push(
      ...anthropicMessageSections(
        message,
        buildMessageLabel(asString(message.role) ?? "unknown", index + 1),
      ),
    );
  }

  if (requestToolNames.length > 0) {
    requestSections.push({
      kind: "tool_definitions",
      label: "Available tools",
      data: {
        tools: asRecordArray(request.tools) ?? request.tools,
      },
      language: "json",
    });
  }

  const requestSettings = omitRecordKeys(request, ["system", "messages", "tools"]);
  if (hasMeaningfulRequestSettings(requestSettings)) {
    requestSections.push(structuredJsonSection("settings", "Request settings", requestSettings));
  }

  return {
    provider: "anthropic",
    summary: {
      provider: "anthropic",
      model: asString(request.model),
      inputTokens: undefined,
      outputTokens: undefined,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
      stopReason: undefined,
      requestMessageCount: messages.length,
      requestToolCount: requestToolNames.length,
      responseMessageCount: undefined,
      responseToolCallCount: undefined,
      responsePreview: undefined,
      toolCallNames: undefined,
    },
    requestSections: requestSections.length > 0 ? requestSections : undefined,
  };
}

function normalizeAnthropicResponsePayload(
  responsePayload: unknown,
): NormalizedPayloadCandidate | null {
  const response = asRecord(responsePayload);
  if (!response) {
    return null;
  }

  const content = asRecordArray(response.content);
  if (!content) {
    return null;
  }

  const responseSections = anthropicContentSections(content, "Assistant response");
  const responseText = collectAnthropicText(content);
  const responseToolNames = content
    .map((block) => (asString(block.type) === "tool_use" ? asString(block.name) : undefined))
    .filter((name): name is string => typeof name === "string");

  const usage = asRecord(response.usage);
  return {
    provider: "anthropic",
    summary: {
      provider: "anthropic",
      model: asString(response.model),
      inputTokens: asNumber(usage?.input_tokens),
      outputTokens: asNumber(usage?.output_tokens),
      cacheCreationInputTokens: asNumber(usage?.cache_creation_input_tokens),
      cacheReadInputTokens: asNumber(usage?.cache_read_input_tokens),
      stopReason: asString(response.stop_reason),
      requestMessageCount: undefined,
      requestToolCount: undefined,
      responseMessageCount:
        responseText !== undefined || responseToolNames.length > 0 ? 1 : undefined,
      responseToolCallCount:
        responseToolNames.length > 0 ? responseToolNames.length : undefined,
      responsePreview: responseText ? truncateText(responseText) : undefined,
      toolCallNames: responseToolNames.length > 0 ? responseToolNames : undefined,
    },
    responseSections: responseSections.length > 0 ? responseSections : undefined,
  };
}

function normalizeGeminiRequestPayload(
  requestPayload: unknown,
): NormalizedPayloadCandidate | null {
  const request = asRecord(requestPayload);
  if (!request) {
    return null;
  }

  const contents = asRecordArray(request.contents);
  if (!contents) {
    return null;
  }

  const requestSections: LlmContextSection[] = [];
  const config = asRecord(request.config);
  const systemText = extractGeminiSystemInstructionText(config?.systemInstruction);
  if (systemText !== undefined) {
    requestSections.push({
      kind: "system",
      label: "System instruction",
      role: "system",
      text: systemText,
    });
  }

  for (const [index, content] of contents.entries()) {
    requestSections.push(...geminiContentSections(content, index + 1));
  }

  const requestToolNames = extractGeminiToolNames(config?.tools);
  if (requestToolNames.length > 0) {
    requestSections.push({
      kind: "tool_definitions",
      label: "Available tools",
      data: {
        tools: asRecordArray(config?.tools) ?? config?.tools,
      },
      language: "json",
    });
  }

  const requestSettings = buildGeminiRequestSettings(request, config);
  if (hasMeaningfulRequestSettings(requestSettings)) {
    requestSections.push(
      structuredJsonSection("settings", "Generation config", requestSettings),
    );
  }

  return {
    provider: "gemini",
    summary: {
      provider: "gemini",
      model: asString(request.model),
      inputTokens: undefined,
      outputTokens: undefined,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
      stopReason: undefined,
      requestMessageCount: contents.length,
      requestToolCount: requestToolNames.length,
      responseMessageCount: undefined,
      responseToolCallCount: undefined,
      responsePreview: undefined,
      toolCallNames: undefined,
    },
    requestSections: requestSections.length > 0 ? requestSections : undefined,
  };
}

function normalizeGeminiResponsePayload(
  responsePayload: unknown,
): NormalizedPayloadCandidate | null {
  const response = asRecord(responsePayload);
  if (!response) {
    return null;
  }

  const responseText = asString(response.text);
  const responseFunctionSections = geminiFunctionCallSections(
    response.functionCalls,
    "Response function call",
  );
  const usage = asRecord(response.usageMetadata);
  if (responseText === undefined && responseFunctionSections.length === 0) {
    return null;
  }

  const responseSections: LlmContextSection[] = [];
  if (responseText !== undefined) {
    responseSections.push({
      kind: "message",
      label: "Assistant response",
      role: "model",
      text: responseText,
    });
  }
  responseSections.push(...responseFunctionSections);

  const toolCallNames = responseFunctionSections
    .map((section) => section.toolName)
    .filter((name): name is string => typeof name === "string");

  return {
    provider: "gemini",
    summary: {
      provider: "gemini",
      model: asString(response.model),
      inputTokens: asNumber(usage?.promptTokenCount),
      outputTokens: asNumber(usage?.candidatesTokenCount),
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
      stopReason: asString(response.finishReason),
      requestMessageCount: undefined,
      requestToolCount: undefined,
      responseMessageCount:
        responseText !== undefined || responseFunctionSections.length > 0
          ? 1
          : undefined,
      responseToolCallCount:
        responseFunctionSections.length > 0
          ? responseFunctionSections.length
          : undefined,
      responsePreview: responseText ? truncateText(responseText) : undefined,
      toolCallNames: toolCallNames.length > 0 ? toolCallNames : undefined,
    },
    responseSections: responseSections.length > 0 ? responseSections : undefined,
  };
}

function anthropicSystemSections(system: unknown): LlmContextSection[] {
  const text = extractAnthropicSystemText(system);
  if (!text) {
    return [];
  }
  return [
    {
      kind: "system",
      label: "System prompt",
      role: "system",
      text,
    },
  ];
}

function anthropicMessageSections(
  message: Record<string, unknown>,
  label: string,
): LlmContextSection[] {
  const role = asString(message.role) ?? "unknown";
  const content = message.content;
  const sections: LlmContextSection[] = [];
  const text = collectAnthropicText(content);
  if (text) {
    sections.push({
      kind: "message",
      label,
      role,
      text,
    });
  }

  for (const block of asRecordArray(content) ?? []) {
    const type = asString(block.type);
    if (type === "tool_use") {
      sections.push({
        kind: "tool_use",
        label: `${label} tool use`,
        role,
        toolName: asString(block.name),
        data: asRecord(block.input) ?? block.input,
        text: previewStructuredValue(block.input),
      });
      continue;
    }

    if (isAnthropicToolResultType(type)) {
      sections.push({
        kind: "tool_result",
        label: `${label} tool result`,
        role,
        toolName: asString(block.name) ?? asString(block.tool_use_id),
        text: collectAnthropicToolResultText(block),
      });
    }
  }

  return sections;
}

function anthropicContentSections(
  content: Record<string, unknown>[],
  label: string,
): LlmContextSection[] {
  return anthropicMessageSections(
    {
      role: "assistant",
      content,
    },
    label,
  );
}

function geminiContentSections(
  content: Record<string, unknown>,
  index: number,
): LlmContextSection[] {
  const role = asString(content.role) ?? "unknown";
  const parts = asRecordArray(content.parts) ?? [];
  const sections: LlmContextSection[] = [];
  const textParts: string[] = [];

  for (const part of parts) {
    const text = asString(part.text);
    if (text) {
      textParts.push(text);
      continue;
    }

    const inlineData = asRecord(part.inlineData);
    if (inlineData) {
      const mimeType = asString(inlineData.mimeType) ?? "application/octet-stream";
      textParts.push(`[inline data: ${mimeType}]`);
      continue;
    }

    const functionCall = asRecord(part.functionCall);
    if (functionCall) {
      sections.push({
        kind: "function_call",
        label: `${buildMessageLabel(role, index)} function call`,
        role,
        toolName: asString(functionCall.name),
        data: asRecord(functionCall.args) ?? functionCall.args,
        text: previewStructuredValue(functionCall.args),
      });
      continue;
    }

    const functionResponse = asRecord(part.functionResponse);
    if (functionResponse) {
      sections.push({
        kind: "function_response",
        label: `${buildMessageLabel(role, index)} function response`,
        role,
        toolName: asString(functionResponse.name),
        data: asRecord(functionResponse.response) ?? functionResponse.response,
        text: previewStructuredValue(functionResponse.response),
      });
    }
  }

  const text = joinTextParts(textParts);
  if (text) {
    sections.unshift({
      kind: "message",
      label: buildMessageLabel(role, index),
      role,
      text,
    });
  }

  return sections;
}

function openAiToolCallSections(
  toolCalls: unknown,
  labelPrefix: string,
): LlmContextSection[] {
  return (asRecordArray(toolCalls) ?? []).map((toolCall, index) => {
    const fn = asRecord(toolCall.function);
    return {
      kind: "function_call",
      label: `${labelPrefix} ${index + 1}`,
      role: "assistant",
      toolName: asString(fn?.name),
      data: parseJsonValue(asString(fn?.arguments)),
      text: previewStructuredValue(parseJsonValue(asString(fn?.arguments))),
    };
  });
}

function geminiFunctionCallSections(
  functionCalls: unknown,
  labelPrefix: string,
): LlmContextSection[] {
  return (asRecordArray(functionCalls) ?? []).map((call, index) => ({
    kind: "function_call",
    label: `${labelPrefix} ${index + 1}`,
    role: "model",
    toolName: asString(call.name),
    data: asRecord(call.args) ?? call.args,
    text: previewStructuredValue(call.args),
  }));
}

function extractOpenAiRequestToolNames(tools: unknown): string[] {
  return (asRecordArray(tools) ?? [])
    .map((tool) => asString(asRecord(tool.function)?.name))
    .filter((name): name is string => typeof name === "string");
}

function extractAnthropicToolNames(tools: unknown): string[] {
  return (asRecordArray(tools) ?? [])
    .map((tool) => asString(tool.name))
    .filter((name): name is string => typeof name === "string");
}

function extractGeminiToolNames(tools: unknown): string[] {
  const toolGroups = asRecordArray(tools) ?? [];
  const names: string[] = [];
  for (const toolGroup of toolGroups) {
    for (const declaration of asRecordArray(toolGroup.functionDeclarations) ?? []) {
      const name = asString(declaration.name);
      if (name) {
        names.push(name);
      }
    }
  }
  return names;
}

function extractOpenAiContentText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return hasMeaningfulText(content) ? content : undefined;
  }

  const parts = asRecordArray(content);
  if (!parts) {
    return undefined;
  }

  const textParts: string[] = [];
  for (const part of parts) {
    const type = asString(part.type);
    if (type === "text" || type === "input_text" || type === "output_text") {
      const text = asString(part.text);
      if (text) {
        textParts.push(text);
      }
      continue;
    }

    if (type === "image_url" || type === "input_image") {
      textParts.push("[image]");
      continue;
    }

    if (type === "file") {
      textParts.push("[file]");
    }
  }

  return joinTextParts(textParts);
}

function extractAnthropicSystemText(system: unknown): string | undefined {
  if (typeof system === "string") {
    return hasMeaningfulText(system) ? system : undefined;
  }

  const parts = asRecordArray(system);
  if (!parts) {
    return undefined;
  }

  const textParts = parts
    .map((part) => asString(part.text))
    .filter((text): text is string => typeof text === "string");
  return joinTextParts(textParts);
}

function extractGeminiSystemInstructionText(systemInstruction: unknown): string | undefined {
  if (typeof systemInstruction === "string") {
    return hasMeaningfulText(systemInstruction) ? systemInstruction : undefined;
  }

  const record = asRecord(systemInstruction);
  if (!record) {
    return undefined;
  }

  const parts = asRecordArray(record.parts) ?? [];
  const textParts = parts
    .map((part) => asString(part.text))
    .filter((text): text is string => typeof text === "string");
  return joinTextParts(textParts);
}

function collectAnthropicText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return hasMeaningfulText(content) ? content : undefined;
  }

  const blocks = asRecordArray(content);
  if (!blocks) {
    return undefined;
  }

  const textParts: string[] = [];
  for (const block of blocks) {
    const type = asString(block.type);
    if (type === "text") {
      const text = asString(block.text);
      if (text) {
        textParts.push(text);
      }
      continue;
    }

    if (type === "thinking") {
      const thinking = asString(block.thinking);
      if (thinking) {
        textParts.push(thinking);
      }
      continue;
    }

    if (type === "redacted_thinking") {
      textParts.push("[redacted thinking]");
      continue;
    }

    if (type === "image") {
      textParts.push("[image]");
      continue;
    }

    if (isAnthropicToolResultType(type)) {
      const resultText = collectAnthropicToolResultText(block);
      if (resultText) {
        textParts.push(resultText);
      }
    }
  }

  return joinTextParts(textParts);
}

function isAnthropicToolResultType(type: string | undefined): boolean {
  return type === "tool_result" || type === "web_search_tool_result";
}

function collectAnthropicToolResultText(
  block: Record<string, unknown>,
): string | undefined {
  if (asString(block.type) === "web_search_tool_result") {
    return "[Web search results]";
  }
  return collectAnthropicText(block.content);
}

function buildMessageLabel(role: string, index: number): string {
  const capitalizedRole =
    role.length > 0 ? role[0]!.toUpperCase() + role.slice(1) : "Message";
  if (role === "system") {
    return "System prompt";
  }
  return `${capitalizedRole} message ${index}`;
}

function buildGeminiRequestSettings(
  request: Record<string, unknown>,
  config: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const topLevelSettings = omitRecordKeys(request, ["contents", "config"]);
  const configSettings = omitRecordKeys(config, ["systemInstruction", "tools"]);

  if (!topLevelSettings && !configSettings) {
    return undefined;
  }

  return {
    ...(topLevelSettings ?? {}),
    ...(configSettings ? { config: configSettings } : {}),
  };
}

function structuredJsonSection(
  kind: LlmContextSection["kind"],
  label: string,
  data: unknown,
): LlmContextSection {
  return {
    kind,
    label,
    data,
    language: "json",
  };
}

function hasMeaningfulRequestSettings(
  settings: Record<string, unknown> | undefined,
): settings is Record<string, unknown> {
  if (!settings) {
    return false;
  }

  const keys = Object.keys(settings);
  return !(keys.length === 1 && keys[0] === "model");
}

function omitRecordKeys(
  record: Record<string, unknown> | null,
  omittedKeys: string[],
): Record<string, unknown> | undefined {
  if (!record) {
    return undefined;
  }

  const filteredEntries = Object.entries(record).filter(
    ([key, value]) => !omittedKeys.includes(key) && value !== undefined,
  );
  if (filteredEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(filteredEntries);
}

function previewStructuredValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return truncateText(value);
  }
  try {
    return truncateText(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function parseJsonValue(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function joinTextParts(parts: string[]): string | undefined {
  if (parts.length === 0) {
    return undefined;
  }
  const text = parts.join("\n\n");
  return hasMeaningfulText(text) ? text : undefined;
}

function truncateText(text: string, maxLength = 280): string {
  const normalized = normalizeText(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : "";
}

function hasMeaningfulText(text: string): boolean {
  return text.trim().length > 0;
}

function mergeSummaryFragments(
  requestSummary: LlmContextSummary | undefined,
  responseSummary: LlmContextSummary | undefined,
): LlmContextSummary | undefined {
  if (!requestSummary && !responseSummary) {
    return undefined;
  }

  const summary = {
    ...(requestSummary ?? responseSummary)!,
  } as LlmContextSummary;

  if (!requestSummary || !responseSummary) {
    return summary;
  }

  for (const [key, value] of Object.entries(responseSummary) as [
    keyof LlmContextSummary,
    LlmContextSummary[keyof LlmContextSummary],
  ][]) {
    if (value !== undefined) {
      summary[key] = value as never;
    }
  }

  return summary;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asRecordArray(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry != null && !Array.isArray(entry),
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
