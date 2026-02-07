import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";

import { getEditorPage, updateEditorPage } from "@/lib/gcp";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequest {
  messages: ChatMessage[];
  agentId?: string;
  currentPage?: string;
  username?: string;
}

const SYSTEM_PROMPT = `You are Velly, a friendly and helpful AI agent builder assistant. You help users configure, improve, and understand their AI agents.

Your personality:
- Friendly and approachable
- Knowledgeable about AI agents and their configuration
- Helpful and proactive in suggesting improvements

You have access to tools that let you view and edit the user's agent editor page. The editor page is a React TSX component stored in the cloud that renders the ENTIRE agent editor UI (header, tabs, all tab content). When users ask you to change their editor UI, use these tools to fetch the current source, modify it, and save it back.

When editing the editor page:
- The component receives props: agentId (string), username (string | null)
- It has access to React hooks: useState, useEffect, useCallback, useMemo, useRef
- It uses Tailwind CSS classes for styling
- The main component function must be named "Editor"
- The editor manages its own state including activeTab, agent data fetching, save/kill operations
- Do NOT include import or export statements - dependencies are injected at runtime

When users ask questions:
- Provide clear, actionable advice
- Explain concepts in simple terms
- Be encouraging and supportive

CRITICAL: Keep every response to 1-2 sentences max. Be direct and concise. No bullet points, no lengthy explanations in your replies. If the user needs more detail, they will ask.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_editor_page",
    description:
      "Fetch the current React TSX source code of the user's agent editor page. Use this to see what the editor currently looks like before making changes.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "update_editor_page",
    description:
      "Update the user's agent editor page with new React TSX source code. The source should be valid TSX that defines a function named 'Editor' accepting { agentId, username } props. Do NOT include import/export statements.",
    input_schema: {
      type: "object" as const,
      properties: {
        source: {
          type: "string",
          description: "The new React TSX source code for the editor page",
        },
      },
      required: ["source"],
    },
  },
];

interface TextToolCall {
  name: string;
  arguments: Record<string, string>;
}

function parseTextToolCalls(text: string): {
  toolCalls: TextToolCall[];
  cleanedText: string;
} {
  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const toolCalls: TextToolCall[] = [];
  let match;

  while ((match = toolCallRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as TextToolCall;
      if (parsed.name) {
        toolCalls.push(parsed);
      }
    } catch {
      console.warn("[Velly Chat] Failed to parse text-based tool call:", match[1]);
    }
  }

  const cleanedText = text.replace(toolCallRegex, "").trim();
  return { toolCalls, cleanedText };
}

async function handleToolCall(
  toolName: string,
  toolInput: Record<string, string>,
  agentId: string
): Promise<string> {
  console.log(`[Velly Chat] 🔧 Executing tool: ${toolName}`, { agentId, toolInput });

  if (toolName === "get_editor_page") {
    const source = await getEditorPage(agentId);
    if (!source) {
      console.log(`[Velly Chat] 📄 No editor page found for agent ${agentId}`);
      return "No editor page found for this agent. The default template will be used.";
    }
    console.log(`[Velly Chat] 📄 Fetched editor page for agent ${agentId} (${source.length} chars)`);
    return source;
  }

  if (toolName === "update_editor_page") {
    const { source } = toolInput;
    if (!source) {
      return "Error: source content is required";
    }

    const success = await updateEditorPage(agentId, source);
    if (!success) {
      console.error(`[Velly Chat] ❌ Failed to update editor page for agent ${agentId}`);
      return "Error: Failed to update the editor page in storage.";
    }
    console.log(`[Velly Chat] ✅ Updated editor page for agent ${agentId} (${source.length} chars)`);
    return "Editor page updated successfully. The user will see the changes when they refresh.";
  }

  return `Unknown tool: ${toolName}`;
}

export async function POST(request: Request) {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`[Velly Chat] 🚀 [${requestId}] === REQUEST START ===`);
  
  try {
    console.log(`[Velly Chat] 📥 [${requestId}] Parsing request body...`);
    const body: ChatRequest = await request.json();
    const { messages, agentId, currentPage, username: chatUsername } = body;

    console.log(`[Velly Chat] 📋 [${requestId}] Request parsed:`, {
      messageCount: messages?.length,
      agentId: agentId || "(none)",
      currentPage: currentPage || "(none)",
      username: chatUsername || "(none)",
      firstMessage: messages?.[0]?.content?.substring(0, 100) || "(empty)",
    });

    if (!messages || messages.length === 0) {
      console.error(`[Velly Chat] ❌ [${requestId}] No messages provided`);
      return NextResponse.json(
        { error: "Messages are required" },
        { status: 400 }
      );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error(`[Velly Chat] ❌ [${requestId}] ANTHROPIC_API_KEY is not configured`);
      return NextResponse.json(
        { error: "AI service is not configured" },
        { status: 500 }
      );
    }
    console.log(`[Velly Chat] 🔑 [${requestId}] API key present (${apiKey.substring(0, 10)}...)`);

    const anthropic = new Anthropic({ apiKey });

    const contextParts: string[] = [];
    if (chatUsername) {
      contextParts.push(`The user's name is ${chatUsername}.`);
    }
    if (currentPage) {
      contextParts.push(`The user is currently on the page: ${currentPage}.`);
    }
    if (agentId) {
      contextParts.push(`The user is viewing agent ID: ${agentId}.`);
    }
    const contextSuffix = contextParts.length > 0
      ? `\n\nContext about the current session:\n${contextParts.join(" ")}`
      : "";

    const anthropicMessages: Anthropic.MessageParam[] = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    const systemPrompt = SYSTEM_PROMPT + contextSuffix;
    const tools = agentId ? TOOLS : [];

    console.log(`[Velly Chat] 🤖 [${requestId}] Calling Anthropic API...`, {
      model: "claude-opus-4-6",
      messageCount: anthropicMessages.length,
      hasTools: tools.length > 0,
      systemPromptLength: systemPrompt.length,
    });

    const apiCallStart = Date.now();
    let response = await anthropic.messages
      .stream({
        model: "claude-opus-4-6",
        max_tokens: 128000,
        system: systemPrompt,
        ...(tools.length > 0 ? { tools } : {}),
        messages: anthropicMessages,
      })
      .finalMessage();

    const apiCallDuration = Date.now() - apiCallStart;
    console.log(`[Velly Chat] ✅ [${requestId}] Anthropic API responded in ${apiCallDuration}ms`, {
      stopReason: response.stop_reason,
      contentBlocks: response.content.length,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });

    const MAX_TOOL_ROUNDS = 5;
    let toolRound = 0;

    while (response.stop_reason === "tool_use" && toolRound < MAX_TOOL_ROUNDS) {
      toolRound++;
      console.log(`[Velly Chat] 🔄 [${requestId}] Tool round ${toolRound}/${MAX_TOOL_ROUNDS}`);

      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      console.log(`[Velly Chat] 🔧 [${requestId}] Found ${toolUseBlocks.length} tool calls:`, 
        toolUseBlocks.map(t => t.name));

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        console.log(`[Velly Chat] 🔧 [${requestId}] Executing tool: ${toolUse.name}`);
        const result = agentId
          ? await handleToolCall(
              toolUse.name,
              toolUse.input as Record<string, string>,
              agentId
            )
          : `Tool ${toolUse.name} requires an agent context`;

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      anthropicMessages.push({
        role: "assistant",
        content: response.content,
      });
      anthropicMessages.push({
        role: "user",
        content: toolResults,
      });

      console.log(`[Velly Chat] 🤖 [${requestId}] Calling Anthropic API again (after tools)...`);
      const toolApiCallStart = Date.now();
      response = await anthropic.messages
        .stream({
          model: "claude-opus-4-6",
          max_tokens: 128000,
          system: systemPrompt,
          ...(tools.length > 0 ? { tools } : {}),
          messages: anthropicMessages,
        })
        .finalMessage();

      const toolApiCallDuration = Date.now() - toolApiCallStart;
      console.log(`[Velly Chat] ✅ [${requestId}] Tool follow-up responded in ${toolApiCallDuration}ms`, {
        stopReason: response.stop_reason,
      });
    }

    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text"
    );

    if (!textBlock) {
      console.error(`[Velly Chat] ❌ [${requestId}] No text block in response`, {
        contentTypes: response.content.map(b => b.type),
      });
      return NextResponse.json(
        { error: "No text response from AI" },
        { status: 500 }
      );
    }

    console.log(`[Velly Chat] 📝 [${requestId}] Got text response (${textBlock.text.length} chars)`);

    let finalText = textBlock.text;

    if (agentId) {
      const { toolCalls, cleanedText } = parseTextToolCalls(finalText);
      if (toolCalls.length > 0) {
        console.log(`[Velly Chat] 🔧 [${requestId}] Found ${toolCalls.length} text-based tool call(s), executing...`);

        const toolResultMessages: string[] = [];
        for (const toolCall of toolCalls) {
          const result = await handleToolCall(
            toolCall.name,
            toolCall.arguments,
            agentId
          );
          toolResultMessages.push(
            `Tool ${toolCall.name} result: ${result}`
          );
        }

        anthropicMessages.push({
          role: "assistant",
          content: finalText,
        });
        anthropicMessages.push({
          role: "user",
          content: `[Tool results]\n${toolResultMessages.join("\n")}\n\nPlease provide a brief summary of what you did. Do NOT include any <tool_call> tags in your response.`,
        });

        console.log(`[Velly Chat] 🤖 [${requestId}] Calling Anthropic API for text-tool follow-up...`);
        const followUp = await anthropic.messages
          .stream({
            model: "claude-opus-4-6",
            max_tokens: 128000,
            system: systemPrompt,
            messages: anthropicMessages,
          })
          .finalMessage();

        const followUpText = followUp.content.find(
          (block): block is Anthropic.TextBlock => block.type === "text"
        );

        finalText = followUpText ? followUpText.text.trim() : cleanedText;
        console.log(`[Velly Chat] 📝 [${requestId}] Follow-up text (${finalText.length} chars)`);
      }
    }

    const responsePayload = { content: finalText.trim() };
    console.log(`[Velly Chat] 🎉 [${requestId}] === REQUEST SUCCESS ===`, {
      responseLength: responsePayload.content.length,
      preview: responsePayload.content.substring(0, 100),
    });

    return NextResponse.json(responsePayload);
  } catch (error) {
    console.error(`[Velly Chat] ❌ [${requestId}] === REQUEST FAILED ===`, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json(
      { error: "Failed to process chat request" },
      { status: 500 }
    );
  }
}
