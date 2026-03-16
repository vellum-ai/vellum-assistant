/**
 * Token Estimator Accuracy Benchmark
 *
 * Validates estimatePromptTokens() against Anthropic's countTokens API
 * to measure the estimation gap. Requires ANTHROPIC_API_KEY to run.
 *
 * Run: cd assistant && ANTHROPIC_API_KEY=<key> bun test src/__tests__/token-estimator-accuracy.benchmark.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  estimatePromptTokens,
  estimateToolsTokens,
} from "../context/token-estimator.js";
import type { Message, ToolDefinition } from "../providers/types.js";

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-20250514";

// Skip all tests if no API key is available
const describeWithApi = API_KEY ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers to construct realistic payloads matching a desktop conversation
// ---------------------------------------------------------------------------

/** Generates a system prompt similar to production (~35-40K chars) */
function makeSystemPrompt(size: "small" | "production" = "small"): string {
  const base = [
    "You are a helpful AI assistant integrated into a desktop application.",
    "You have access to the user's workspace, files, and tools.",
    "Follow the user's instructions carefully and use tools when needed.",
    "",
    "## Guidelines",
    "- Be concise and helpful",
    "- Use tools to accomplish tasks rather than asking the user to do them",
    "- When editing files, read them first to understand context",
    "- Follow existing code style and conventions",
    "- Ask clarifying questions when the request is ambiguous",
  ];

  if (size === "small") {
    return base.join("\n");
  }

  // Production-sized system prompt (~35K chars) with realistic sections
  const sections: string[] = [...base];

  // Identity section (~1K chars)
  sections.push(
    "",
    "## Identity",
    "You are Jarvis, a personal AI assistant. Your emoji is 🤖.",
    "You live in San Francisco, California.",
    "You are curious, thorough, and always eager to help.",
    "You express yourself with warmth and precision.",
  );

  // Soul section (~3K chars) - personality, boundaries, communication style
  sections.push(
    "",
    "## Soul & Personality",
    "You are an AI assistant with a distinct personality. You are warm, helpful, and thorough.",
    "You have boundaries: you do not pretend to be human, you acknowledge uncertainty honestly,",
    "and you prioritize the user's safety and privacy above all else.",
    "",
    "### Communication Style",
    "- Be direct and concise, but not curt",
    "- Use technical language when appropriate, but explain jargon",
    "- Match the user's energy level and formality",
    "- Use humor sparingly and only when the context is light",
    "- Never use excessive exclamation marks or emojis unless the user does",
    "",
    "### Decision Making",
    "- When faced with ambiguity, ask clarifying questions",
    "- When multiple approaches exist, recommend the best one with reasoning",
    "- When you make a mistake, acknowledge it immediately and correct course",
    "- When you don't know something, say so rather than guessing",
  );

  // CLI reference section (~5K chars)
  sections.push(
    "",
    "## CLI Reference",
    "The assistant CLI provides these commands:",
    "",
    "### File Operations",
    "- `file read <path>` — Read file contents",
    "- `file write <path> <content>` — Write file contents",
    "- `file edit <path> --old <old> --new <new>` — Edit file",
    "- `file list [path]` — List directory contents",
    "- `file search <query> [--type <type>]` — Search files",
    "- `file move <from> <to>` — Move/rename file",
    "- `file copy <from> <to>` — Copy file",
    "- `file delete <path>` — Delete file (requires confirmation)",
    "",
    "### Terminal Operations",
    "- `bash <command>` — Execute shell command",
    "- `bash --timeout <seconds> <command>` — Execute with timeout",
    "- `bash --background <command>` — Run in background",
    "",
    "### Memory Operations",
    "- `memory recall <query>` — Search memories",
    "- `memory store <key> <content>` — Store memory",
    "- `memory forget <key>` — Delete memory",
    "- `memory list` — List all memories",
    "",
    "### Web Operations",
    "- `web search <query>` — Search the web",
    "- `web fetch <url>` — Fetch URL content",
    "- `web screenshot <url>` — Take screenshot",
    "",
    "### Skill Operations",
    "- `skill list` — List available skills",
    "- `skill run <name> [args]` — Execute skill",
    "- `skill create <name>` — Create new skill",
    "- `skill edit <name>` — Edit existing skill",
  );

  // Tool permission section (~3K chars)
  sections.push(
    "",
    "## Tool Permissions & Approval Gates",
    "Some tools require explicit user approval before execution:",
    "",
    "### High-Risk Tools (always require approval)",
    "- `bash` — Shell commands that modify the system",
    "- `file_write` — Creating or overwriting files",
    "- `file_edit` — Modifying existing files",
    "- `file_delete` — Deleting files",
    "- `credential_store set` — Storing credentials",
    "",
    "### Medium-Risk Tools (require approval on first use per session)",
    "- `web_fetch` — Fetching external URLs",
    "- `computer_use_*` — All computer use tools",
    "- `messaging_send` — Sending messages",
    "- `gmail_send` — Sending emails",
    "",
    "### Low-Risk Tools (auto-approved)",
    "- `file_read` — Reading files",
    "- `memory_recall` — Searching memories",
    "- `web_search` — Web searches",
    "- `tasks_list` — Listing tasks",
    "- `contacts_search` — Searching contacts",
    "",
    "When a tool requires approval, explain what you're about to do and why,",
    "then wait for the user's confirmation before proceeding.",
    "Never bypass approval gates or attempt to run commands that circumvent them.",
  );

  // Channel awareness section (~2K chars)
  sections.push(
    "",
    "## Channel Awareness",
    "You may be accessed through different channels, each with different capabilities:",
    "",
    "### Desktop App (full capabilities)",
    "- File system access, terminal, computer use, all tools available",
    "- Rich text rendering with markdown support",
    "- Image and file attachment support",
    "",
    "### Voice Channel (limited capabilities)",
    "- Text-to-speech output, push-to-talk input",
    "- No file system access, no computer use",
    "- Keep responses concise for audio consumption",
    "",
    "### Dashboard (read-only view)",
    "- Can view conversation history and memories",
    "- Cannot execute tools or modify files",
    "- Used for monitoring and reviewing assistant activity",
  );

  // Memory & continuity section (~2K chars)
  sections.push(
    "",
    "## Memory & Continuity",
    "You have access to persistent memory that survives across conversations.",
    "Use memory to store important context, user preferences, project details,",
    "and anything that would be useful to recall in future conversations.",
    "",
    "### Memory Best Practices",
    "- Store user preferences when explicitly stated (e.g., 'I prefer tabs over spaces')",
    "- Store project-specific context (e.g., 'This project uses PostgreSQL 15')",
    "- Store decisions and their reasoning (e.g., 'We chose Redis over Memcached because...')",
    "- Update memories when information changes",
    "- Don't store trivial or ephemeral information",
    "- Don't store sensitive information (passwords, API keys, etc.)",
  );

  // Integration guidance (~3K chars)
  sections.push(
    "",
    "## Integration Guidance",
    "The assistant supports MCP (Model Context Protocol) servers for extending capabilities.",
    "When the user asks about integrations:",
    "",
    "### Supported Integrations",
    "- Google Workspace (Gmail, Calendar, Drive, Contacts)",
    "- Slack (messaging, channel management)",
    "- GitHub (repositories, issues, pull requests)",
    "- Linear (project management, issue tracking)",
    "- Notion (documents, databases)",
    "- Sentry (error tracking, issue management)",
    "",
    "### OAuth Setup",
    "Most integrations use OAuth for authentication.",
    "Guide the user through the OAuth flow when setting up a new integration:",
    "1. Navigate to Settings > Integrations",
    "2. Click 'Connect' for the desired service",
    "3. Authorize in the browser popup",
    "4. Confirm the connection is active",
    "",
    "### MCP Servers",
    "Custom MCP servers can be added via the config file.",
    "The config lives at ~/.vellum/config.json.",
    "Each MCP server entry requires: name, command, args, and optional env.",
  );

  // Dynamic skills catalog (~5K chars)
  sections.push("", "## Available Skills", "<available_skills>");
  const skillCategories = [
    {
      id: "gmail",
      name: "Gmail",
      desc: "Send, search, draft, and manage Gmail messages",
    },
    {
      id: "calendar",
      name: "Google Calendar",
      desc: "Create, list, update, and delete calendar events",
    },
    {
      id: "slack",
      name: "Slack",
      desc: "Send messages, search channels, manage threads",
    },
    { id: "contacts", name: "Contacts", desc: "Search and manage contacts" },
    {
      id: "tasks",
      name: "Tasks",
      desc: "Create, list, update, and complete tasks",
    },
    {
      id: "browser",
      name: "Browser",
      desc: "Navigate web pages, take screenshots, interact with web content",
    },
    {
      id: "schedule",
      name: "Schedule",
      desc: "Set reminders and schedule recurring tasks",
    },
    {
      id: "messaging",
      name: "Messaging",
      desc: "Send iMessage and SMS messages",
    },
    {
      id: "sequences",
      name: "Sequences",
      desc: "Create and manage multi-step automation workflows",
    },
    {
      id: "playbooks",
      name: "Playbooks",
      desc: "Execute pre-defined operational playbooks",
    },
    {
      id: "notes",
      name: "Notes",
      desc: "Create and manage notes in Apple Notes",
    },
    { id: "music", name: "Music", desc: "Control Apple Music playback" },
    {
      id: "photos",
      name: "Photos",
      desc: "Search and manage photos in Apple Photos",
    },
    {
      id: "maps",
      name: "Maps",
      desc: "Search locations, get directions, find nearby places",
    },
    {
      id: "weather",
      name: "Weather",
      desc: "Get current weather and forecasts",
    },
  ];
  for (const skill of skillCategories) {
    sections.push(
      `  <skill id="${skill.id}" name="${skill.name}" description="${skill.desc}" ` +
        `credential_setup="oauth" enabled="true" />`,
    );
  }
  sections.push("</available_skills>");

  // Attachment handling (~1K chars)
  sections.push(
    "",
    "## Attachment Handling",
    "When sending files to the user, use the <vellum-attachment> tag:",
    '`<vellum-attachment path="/path/to/file" type="image/png" />`',
    "",
    "Supported attachment types:",
    "- Images: png, jpg, gif, webp, svg",
    "- Documents: pdf, docx, xlsx, pptx",
    "- Code: any text file with syntax highlighting",
    "- Archives: zip, tar.gz",
  );

  // Task/schedule routing (~2K chars)
  sections.push(
    "",
    "## Task & Schedule Routing",
    "When the user asks to 'remind me' or 'schedule something', disambiguate:",
    "",
    "- **One-time reminder** → Use `schedule_reminder` tool",
    "- **Recurring task** → Use `tasks_create` with recurrence",
    "- **Calendar event** → Use `google_calendar_create_event`",
    "- **Notification** → Use `send_notification` for immediate alerts",
    "",
    "Ask the user to clarify if the intent is ambiguous.",
    "Default to `schedule_reminder` for simple time-based reminders.",
  );

  // Pad to ~35K chars with additional realistic instruction content
  const currentLength = sections.join("\n").length;
  if (currentLength < 35000) {
    sections.push("", "## Additional Guidelines");
    // Add realistic padding content to reach ~35K
    const guidelines = [
      "When working with code, always read the file before editing it.",
      "When running shell commands, explain what each command does.",
      "When searching the web, summarize the most relevant results.",
      "When managing files, confirm destructive operations with the user.",
      "When scheduling events, confirm the timezone with the user.",
      "When sending messages, confirm the recipient and content before sending.",
      "When managing credentials, never display sensitive values in plain text.",
      "When creating tasks, include a clear due date and priority level.",
      "When editing documents, preserve formatting and structure.",
      "When processing images, describe what you see in detail.",
    ];
    while (sections.join("\n").length < 35000) {
      for (const g of guidelines) {
        sections.push(`- ${g}`);
        if (sections.join("\n").length >= 35000) break;
      }
    }
  }

  return sections.join("\n");
}

/** Generates a runtime-injected user message with workspace HTML content */
function makeRuntimeInjectedMessage(): Message {
  // Simulates the <active_workspace> XML block with app schema and page HTML
  const appSchema = `<app_schema>
  <component name="Sidebar" props="items: NavigationItem[], collapsed: boolean">
    <component name="NavigationItem" props="label: string, icon: string, href: string, active: boolean" />
  </component>
  <component name="MainContent" props="children: ReactNode">
    <component name="Header" props="title: string, breadcrumbs: Breadcrumb[]" />
    <component name="DataTable" props="columns: Column[], rows: Row[], sortBy: string, filterText: string">
      <component name="TableRow" props="cells: Cell[], selected: boolean, onSelect: () => void" />
    </component>
  </component>
  <component name="Modal" props="open: boolean, title: string, onClose: () => void">
    <component name="Form" props="fields: Field[], onSubmit: (data: FormData) => void" />
  </component>
</app_schema>`;

  // Simulate ~30K chars of page HTML (realistic for a complex web app page)
  const pageHtmlLines: string[] = [];
  for (let i = 0; i < 200; i++) {
    pageHtmlLines.push(
      `<div class="row-${i}" data-id="${i}" role="listitem">` +
        `<span class="cell name">Item ${i}: ${`Lorem ipsum dolor sit amet, consectetur adipiscing elit. `.repeat(2)}</span>` +
        `<span class="cell status">${i % 3 === 0 ? "active" : i % 3 === 1 ? "pending" : "completed"}</span>` +
        `<span class="cell date">2026-03-${String((i % 28) + 1).padStart(2, "0")}</span>` +
        `</div>`,
    );
  }

  const fileTree = Array.from(
    { length: 50 },
    (_, i) => `  src/modules/feature-${i}/index.ts`,
  ).join("\n");

  const workspaceXml = [
    "<active_workspace>",
    appSchema,
    "<file_tree>",
    fileTree,
    "</file_tree>",
    "<current_page>",
    "<html>",
    '<body class="app-root">',
    pageHtmlLines.join("\n"),
    "</body>",
    "</html>",
    "</current_page>",
    "</active_workspace>",
  ].join("\n");

  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          workspaceXml +
          "\n\nPlease help me refactor the data table component to support pagination.",
      },
    ],
  };
}

/** Generates tool definitions matching a realistic desktop conversation */
function makeToolDefinitions(): Array<{
  name: string;
  description: string;
  input_schema: object;
}> {
  const tools: Array<{
    name: string;
    description: string;
    input_schema: object;
  }> = [];

  // Core tools (11)
  tools.push(
    {
      name: "bash",
      description:
        "Execute a shell command on the local machine. Use this for running scripts, installing packages, git operations, and other terminal tasks.",
      input_schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of why this command is being run, shown to the user for approval",
          },
          timeout_seconds: {
            type: "number",
            description:
              "Optional timeout in seconds. Defaults to 120. Maximum 600.",
          },
        },
        required: ["command", "reason"],
      },
    },
    {
      name: "file_read",
      description:
        "Read the contents of a file from the local filesystem. Returns the full file content as text. Use this before editing files to understand their current state.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to the file to read",
          },
          offset: {
            type: "number",
            description: "Line number to start reading from (0-indexed)",
          },
          limit: {
            type: "number",
            description: "Maximum number of lines to read",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "file_write",
      description:
        "Write content to a file, creating it if it doesn't exist or overwriting if it does. Use file_edit for surgical changes to existing files.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to write",
          },
          content: {
            type: "string",
            description: "The full content to write to the file",
          },
          reason: {
            type: "string",
            description: "Brief explanation of why this file is being written",
          },
        },
        required: ["path", "content", "reason"],
      },
    },
    {
      name: "file_edit",
      description:
        "Apply a surgical edit to an existing file by replacing a specific string with a new string. The old_string must appear exactly once in the file.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to edit" },
          old_string: {
            type: "string",
            description:
              "The exact string to find and replace (must be unique in the file)",
          },
          new_string: {
            type: "string",
            description: "The replacement string",
          },
          reason: {
            type: "string",
            description: "Brief explanation of the edit",
          },
        },
        required: ["path", "old_string", "new_string", "reason"],
      },
    },
    {
      name: "web_search",
      description:
        "Search the web for information. Returns a list of search results with titles, URLs, and snippets.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
          num_results: {
            type: "number",
            description: "Number of results to return (default 5, max 10)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "web_fetch",
      description:
        "Fetch the content of a URL. Returns the page content as text (HTML stripped to readable text by default).",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
          format: {
            type: "string",
            enum: ["text", "html", "markdown"],
            description: "Output format (default: text)",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "memory_recall",
      description:
        "Search across your memory using hybrid semantic and recency-based retrieval. Use this to find information from past conversations, stored facts, or contextual knowledge.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query to find relevant memories",
          },
          scope: {
            type: "string",
            enum: ["default", "conversation"],
            description:
              "Search scope: 'default' searches all memories, 'conversation' searches only the current conversation",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_manage",
      description:
        "Create, update, or delete a memory entry. Use this to store important information for future reference.",
      input_schema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "update", "delete"],
            description: "The memory operation to perform",
          },
          key: {
            type: "string",
            description: "Unique key identifying this memory",
          },
          content: {
            type: "string",
            description: "The content to store (required for create/update)",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags for categorizing the memory",
          },
        },
        required: ["action", "key"],
      },
    },
    {
      name: "skill_execute",
      description:
        "Execute a loaded skill by name. Skills are pre-defined automation routines that can perform complex multi-step tasks.",
      input_schema: {
        type: "object",
        properties: {
          skill_name: {
            type: "string",
            description: "The name of the skill to execute",
          },
          arguments: {
            type: "object",
            description: "Arguments to pass to the skill",
          },
        },
        required: ["skill_name"],
      },
    },
    {
      name: "asset_search",
      description:
        "Search for assets (images, documents, files) in the workspace by name, type, or content.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          type: {
            type: "string",
            enum: ["image", "document", "code", "any"],
            description: "Filter by asset type",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "credential_store",
      description:
        "Securely store or retrieve credentials for external services. Credentials are encrypted at rest.",
      input_schema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["get", "set", "delete", "list"],
          },
          service: {
            type: "string",
            description: "The service name (e.g., 'github', 'slack')",
          },
          key: {
            type: "string",
            description: "Credential key within the service",
          },
          value: {
            type: "string",
            description: "Credential value (required for 'set')",
          },
        },
        required: ["action", "service"],
      },
    },
  );

  // Computer-use proxy tools (11)
  const computerUseTools = [
    {
      name: "computer_use_click",
      description:
        "Click an element on screen. Prefer element_id from the accessibility tree over x/y coordinates for reliability.",
      props: {
        click_type: {
          type: "string",
          enum: ["single", "double", "right"],
          description: "Type of click",
        },
        element_id: {
          type: "integer",
          description: "Accessibility tree element ID",
        },
        x: { type: "integer", description: "Screen x coordinate" },
        y: { type: "integer", description: "Screen y coordinate" },
        reasoning: {
          type: "string",
          description: "Explanation of what you see and why you're clicking",
        },
        reason: {
          type: "string",
          description: "Brief non-technical explanation for the user",
        },
      },
      required: ["reasoning"],
    },
    {
      name: "computer_use_type_text",
      description:
        "Type text into the currently focused element. The element should already be focused via a click.",
      props: {
        text: { type: "string", description: "The text to type" },
        reasoning: {
          type: "string",
          description: "Why this text is being typed",
        },
        reason: {
          type: "string",
          description: "Brief user-facing explanation",
        },
      },
      required: ["text", "reasoning"],
    },
    {
      name: "computer_use_key",
      description:
        "Press a keyboard key or key combination (e.g., 'Return', 'cmd+c', 'shift+tab').",
      props: {
        key: {
          type: "string",
          description: "Key or key combination to press",
        },
        reasoning: { type: "string", description: "Why this key is pressed" },
        reason: {
          type: "string",
          description: "Brief user-facing explanation",
        },
      },
      required: ["key", "reasoning"],
    },
    {
      name: "computer_use_scroll",
      description:
        "Scroll in a direction at the current cursor position or a specified element.",
      props: {
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
        },
        amount: { type: "integer", description: "Scroll amount in pixels" },
        element_id: {
          type: "integer",
          description: "Element to scroll within",
        },
        reasoning: { type: "string", description: "Why scrolling" },
      },
      required: ["direction", "reasoning"],
    },
    {
      name: "computer_use_drag",
      description: "Drag from one point to another on screen.",
      props: {
        start_x: { type: "integer" },
        start_y: { type: "integer" },
        end_x: { type: "integer" },
        end_y: { type: "integer" },
        reasoning: { type: "string" },
      },
      required: ["start_x", "start_y", "end_x", "end_y", "reasoning"],
    },
    {
      name: "computer_use_wait",
      description:
        "Wait for a specified duration before taking the next action. Use when UI needs time to load.",
      props: {
        seconds: {
          type: "number",
          description: "Number of seconds to wait (max 10)",
        },
        reasoning: { type: "string", description: "Why waiting" },
      },
      required: ["seconds", "reasoning"],
    },
    {
      name: "computer_use_open_app",
      description: "Open a macOS application by name.",
      props: {
        app_name: {
          type: "string",
          description: "The application name (e.g., 'Safari', 'Terminal')",
        },
        reasoning: { type: "string" },
        reason: { type: "string" },
      },
      required: ["app_name", "reasoning"],
    },
    {
      name: "computer_use_run_applescript",
      description:
        "Execute an AppleScript on the user's machine. Use for macOS automation tasks.",
      props: {
        script: { type: "string", description: "The AppleScript code to run" },
        reasoning: { type: "string" },
        reason: { type: "string" },
      },
      required: ["script", "reasoning"],
    },
    {
      name: "computer_use_observe",
      description:
        "Capture and analyze the current screen state. Returns a screenshot and accessibility tree of visible UI elements.",
      props: {
        reasoning: {
          type: "string",
          description: "What you expect to see and why you're observing",
        },
      },
      required: ["reasoning"],
    },
    {
      name: "computer_use_done",
      description:
        "Signal that the computer-use task is complete. Call this when the UI task is finished.",
      props: {
        result: {
          type: "string",
          description: "Summary of what was accomplished",
        },
        reasoning: { type: "string" },
      },
      required: ["result"],
    },
    {
      name: "computer_use_respond",
      description:
        "Send a text response to the user during a computer-use session without performing a UI action.",
      props: {
        message: {
          type: "string",
          description: "The response message",
        },
        reasoning: { type: "string" },
      },
      required: ["message"],
    },
  ];

  for (const cu of computerUseTools) {
    tools.push({
      name: cu.name,
      description: cu.description,
      input_schema: {
        type: "object",
        properties: cu.props,
        required: cu.required,
      },
    });
  }

  // Bundled skill tools (~15 representative ones from gmail, calendar, slack, etc.)
  const skillTools = [
    {
      name: "gmail_send",
      description:
        "Send an email via Gmail. Supports to, cc, bcc, subject, body (plain text or HTML), and attachments.",
      props: {
        account: { type: "string", description: "Gmail account to send from" },
        to: { type: "string", description: "Recipient email address" },
        cc: { type: "string", description: "CC recipients (comma-separated)" },
        bcc: { type: "string", description: "BCC recipients" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body content" },
        html: { type: "boolean", description: "Whether body is HTML" },
        reply_to_message_id: {
          type: "string",
          description: "Message ID to reply to",
        },
        thread_id: { type: "string", description: "Thread ID to add to" },
      },
      required: ["to", "subject", "body"],
    },
    {
      name: "gmail_search",
      description:
        "Search Gmail messages using Gmail search syntax. Returns message summaries.",
      props: {
        query: { type: "string", description: "Gmail search query" },
        max_results: {
          type: "number",
          description: "Max results (default 10)",
        },
        account: { type: "string" },
      },
      required: ["query"],
    },
    {
      name: "gmail_draft",
      description: "Create a draft email in Gmail without sending it.",
      props: {
        account: { type: "string" },
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        html: { type: "boolean" },
      },
      required: ["to", "subject", "body"],
    },
    {
      name: "google_calendar_create_event",
      description:
        "Create a new event on Google Calendar with attendees, location, and recurrence.",
      props: {
        calendar_id: { type: "string" },
        title: { type: "string", description: "Event title" },
        start: { type: "string", description: "Start time (ISO 8601)" },
        end: { type: "string", description: "End time (ISO 8601)" },
        description: { type: "string", description: "Event description" },
        location: { type: "string" },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Email addresses",
        },
        recurrence: { type: "string", description: "RRULE string" },
        timezone: { type: "string" },
      },
      required: ["title", "start", "end"],
    },
    {
      name: "google_calendar_list_events",
      description:
        "List upcoming events from Google Calendar within a time range.",
      props: {
        calendar_id: { type: "string" },
        time_min: { type: "string" },
        time_max: { type: "string" },
        max_results: { type: "number" },
        query: { type: "string" },
      },
      required: [],
    },
    {
      name: "slack_send_message",
      description:
        "Send a message to a Slack channel or DM. Supports threads and formatted text.",
      props: {
        channel: { type: "string", description: "Channel name or ID" },
        text: { type: "string", description: "Message text" },
        thread_ts: {
          type: "string",
          description: "Thread timestamp for replies",
        },
        blocks: { type: "array", description: "Rich text blocks (Block Kit)" },
      },
      required: ["channel", "text"],
    },
    {
      name: "slack_search_messages",
      description:
        "Search Slack messages across channels using Slack search syntax.",
      props: {
        query: { type: "string" },
        sort: { type: "string", enum: ["score", "timestamp"] },
        count: { type: "number" },
      },
      required: ["query"],
    },
    {
      name: "slack_list_channels",
      description:
        "List Slack channels the user has access to, filtered by type.",
      props: {
        types: {
          type: "string",
          description: "Channel types: public, private, im, mpim",
        },
        limit: { type: "number" },
      },
      required: [],
    },
    {
      name: "contacts_search",
      description:
        "Search the user's contacts by name, email, phone, or organization.",
      props: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
    {
      name: "tasks_list",
      description:
        "List tasks from the user's task manager, filtered by status, project, or due date.",
      props: {
        status: { type: "string", enum: ["pending", "completed", "all"] },
        project: { type: "string" },
        due_before: { type: "string", description: "ISO date" },
      },
      required: [],
    },
    {
      name: "tasks_create",
      description: "Create a new task in the user's task manager.",
      props: {
        title: { type: "string" },
        description: { type: "string" },
        due_date: { type: "string" },
        project: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
      },
      required: ["title"],
    },
    {
      name: "browser_navigate",
      description: "Navigate the browser to a URL and return the page content.",
      props: {
        url: { type: "string" },
        wait_for: { type: "string", description: "CSS selector to wait for" },
        timeout: { type: "number" },
      },
      required: ["url"],
    },
    {
      name: "browser_screenshot",
      description:
        "Take a screenshot of the current browser page or a specific element.",
      props: {
        selector: {
          type: "string",
          description: "CSS selector to screenshot (default: full page)",
        },
        full_page: { type: "boolean" },
      },
      required: [],
    },
    {
      name: "schedule_reminder",
      description:
        "Set a reminder for the user at a specific time or relative delay.",
      props: {
        message: { type: "string" },
        at: { type: "string", description: "ISO 8601 datetime" },
        delay_minutes: { type: "number", description: "Minutes from now" },
      },
      required: ["message"],
    },
    {
      name: "messaging_send",
      description: "Send an iMessage or SMS to a contact.",
      props: {
        to: { type: "string", description: "Phone number or contact name" },
        message: { type: "string" },
        service: { type: "string", enum: ["imessage", "sms"] },
      },
      required: ["to", "message"],
    },
  ];

  for (const st of skillTools) {
    tools.push({
      name: st.name,
      description: st.description,
      input_schema: {
        type: "object",
        properties: st.props,
        required: st.required,
      },
    });
  }

  return tools;
}

/**
 * Generate additional bundled skill tools to scale up to production counts.
 * Production sessions have ~135 bundled skill tools across 20+ categories.
 */
function generateBundledSkillTools(
  count: number,
): Array<{ name: string; description: string; input_schema: object }> {
  const categories = [
    "gmail",
    "calendar",
    "slack",
    "contacts",
    "tasks",
    "browser",
    "schedule",
    "messaging",
    "sequences",
    "playbooks",
    "notes",
    "music",
    "photos",
    "maps",
    "weather",
    "reminders",
    "shortcuts",
    "finder",
    "system",
    "notifications",
  ];
  const actions = [
    "list",
    "search",
    "create",
    "update",
    "delete",
    "get",
    "send",
    "archive",
    "export",
    "import",
    "sync",
    "share",
  ];

  const tools: Array<{
    name: string;
    description: string;
    input_schema: object;
  }> = [];

  for (let i = 0; i < count; i++) {
    const cat = categories[i % categories.length];
    const action = actions[i % actions.length];
    const name = `${cat}_${action}_${Math.floor(i / categories.length)}`;

    // Generate realistic parameter schemas of varying complexity
    const paramCount = 3 + (i % 5); // 3-7 parameters
    const properties: Record<string, object> = {};
    const required: string[] = [];

    for (let p = 0; p < paramCount; p++) {
      const paramNames = [
        "query",
        "id",
        "filter",
        "limit",
        "offset",
        "sort_by",
        "sort_order",
        "include_archived",
        "format",
        "output_path",
        "account",
        "workspace",
        "project",
        "label",
        "priority",
        "assignee",
        "due_date",
        "description",
        "title",
        "content",
      ];
      const pName = paramNames[p % paramNames.length];
      properties[pName] = {
        type: p % 3 === 0 ? "string" : p % 3 === 1 ? "number" : "boolean",
        description:
          `The ${pName} parameter for ${cat} ${action} operation. ` +
          `Used to ${action} ${cat} items matching the specified criteria.`,
      };
      if (p < 2) required.push(pName); // First 2 params are required
    }

    tools.push({
      name,
      description:
        `${action.charAt(0).toUpperCase() + action.slice(1)} ${cat} items. ` +
        `Supports filtering by multiple criteria including date range, status, ` +
        `and custom labels. Returns paginated results with metadata.`,
      input_schema: {
        type: "object",
        properties,
        required,
      },
    });
  }

  return tools;
}

/** Build a multi-turn conversation with tool use */
function makeConversationMessages(): Message[] {
  const messages: Message[] = [];

  // Turn 1: User sends initial request (with runtime injection)
  messages.push(makeRuntimeInjectedMessage());

  // Turn 2: Assistant responds with a tool call
  messages.push({
    role: "assistant",
    content: [
      {
        type: "text",
        text: "I'll help you add pagination to the data table. Let me first read the current component to understand its structure.",
      },
      {
        type: "tool_use",
        id: "tu_01",
        name: "file_read",
        input: { path: "src/components/DataTable.tsx" },
      },
    ],
  });

  // Turn 3: Tool result with realistic file content
  const fileContent = Array.from(
    { length: 80 },
    (_, i) =>
      `  // Line ${i + 1}: ${
        i < 10
          ? "import statements and type definitions"
          : i < 30
            ? "interface and props definitions with generics"
            : i < 60
              ? "component implementation with hooks and handlers"
              : "render JSX with table rows and cells"
      }`,
  ).join("\n");

  messages.push({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tu_01",
        content: fileContent,
      },
    ],
  });

  // Turn 4: Assistant reads another file
  messages.push({
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Now let me check the existing pagination utilities.",
      },
      {
        type: "tool_use",
        id: "tu_02",
        name: "bash",
        input: {
          command: "find src -name '*pagina*' -o -name '*Pagina*'",
          reason: "Looking for existing pagination utilities",
        },
      },
    ],
  });

  // Turn 5: Tool result
  messages.push({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tu_02",
        content:
          "src/hooks/usePagination.ts\nsrc/components/Pagination.tsx\nsrc/utils/pagination.ts",
      },
    ],
  });

  return messages;
}

// ---------------------------------------------------------------------------
// Anthropic countTokens helper
// ---------------------------------------------------------------------------

interface CountTokensResult {
  input_tokens: number;
}

async function countTokensViaApi(
  systemPrompt: string,
  messages: Message[],
  tools?: Array<{ name: string; description: string; input_schema: object }>,
): Promise<CountTokensResult> {
  // Use the SDK directly
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: API_KEY });

  // Convert our Message type to Anthropic's expected format
  const anthropicMessages = messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content.map((block) => {
      switch (block.type) {
        case "text":
          return { type: "text" as const, text: block.text };
        case "tool_use":
          return {
            type: "tool_use" as const,
            id: block.id,
            name: block.name,
            input: block.input,
          };
        case "tool_result":
          return {
            type: "tool_result" as const,
            tool_use_id: block.tool_use_id,
            content: block.content,
          };
        default:
          return { type: "text" as const, text: String(block) };
      }
    }),
  }));

  const params: Record<string, unknown> = {
    model: MODEL,
    messages: anthropicMessages,
    system: systemPrompt,
  };

  if (tools && tools.length > 0) {
    params.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }

  const result = await client.messages.countTokens(
    params as unknown as Parameters<typeof client.messages.countTokens>[0],
  );
  return { input_tokens: result.input_tokens };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeWithApi("Token estimator accuracy (requires ANTHROPIC_API_KEY)", () => {
  test("estimation gap: messages + system prompt (no tools)", async () => {
    const systemPrompt = makeSystemPrompt();
    const messages = makeConversationMessages();

    const estimated = estimatePromptTokens(messages, systemPrompt, {
      providerName: "anthropic",
    });

    const actual = await countTokensViaApi(systemPrompt, messages);

    const ratio = actual.input_tokens / estimated;

    console.log("=== No tools ===");
    console.log(`  Estimated:   ${estimated.toLocaleString()} tokens`);
    console.log(
      `  Actual:      ${actual.input_tokens.toLocaleString()} tokens`,
    );
    console.log(`  Ratio:       ${ratio.toFixed(2)}x`);

    // Even without tools, we expect some gap because structured content
    // (HTML, JSON) tokenizes at ~2-3 chars/token vs our assumed 4
    expect(ratio).toBeGreaterThan(0.5); // Sanity: we're not wildly over-estimating
    expect(ratio).toBeLessThan(3.0); // Without tools, gap should be moderate
  });

  test("estimation gap with tools: old vs new estimator", async () => {
    const systemPrompt = makeSystemPrompt();
    const messages = makeConversationMessages();
    const tools = makeToolDefinitions() as ToolDefinition[];

    const toolTokenBudget = estimateToolsTokens(tools);

    // Old estimator: completely ignores tools
    const oldEstimated = estimatePromptTokens(messages, systemPrompt, {
      providerName: "anthropic",
    });

    // New estimator: includes tool token budget
    const newEstimated = estimatePromptTokens(messages, systemPrompt, {
      providerName: "anthropic",
      toolTokenBudget,
    });

    // Anthropic's countTokens includes tool definitions
    const actual = await countTokensViaApi(systemPrompt, messages, tools);

    const oldRatio = actual.input_tokens / oldEstimated;
    const newRatio = actual.input_tokens / newEstimated;

    console.log("=== With tools (old vs new estimator) ===");
    console.log(`  Tools:          ${tools.length}`);
    console.log(`  Tool budget:    ${toolTokenBudget.toLocaleString()} tokens`);
    console.log(
      `  Old estimated:  ${oldEstimated.toLocaleString()} tokens (ratio ${oldRatio.toFixed(2)}x)`,
    );
    console.log(
      `  New estimated:  ${newEstimated.toLocaleString()} tokens (ratio ${newRatio.toFixed(2)}x)`,
    );
    console.log(
      `  Actual:         ${actual.input_tokens.toLocaleString()} tokens`,
    );

    // New estimator should be closer to actual
    expect(newEstimated).toBeGreaterThan(oldEstimated);
    expect(newRatio).toBeLessThan(oldRatio);
    // New ratio should be within 30% of actual
    expect(newRatio).toBeLessThan(1.3);
  });

  test("tool definitions contribute significant tokens", async () => {
    const systemPrompt = makeSystemPrompt();
    const messages = makeConversationMessages();
    const tools = makeToolDefinitions();

    const withoutTools = await countTokensViaApi(systemPrompt, messages);
    const withTools = await countTokensViaApi(systemPrompt, messages, tools);

    const toolTokens = withTools.input_tokens - withoutTools.input_tokens;

    console.log("=== Tool token contribution ===");
    console.log(
      `  Without tools: ${withoutTools.input_tokens.toLocaleString()} tokens`,
    );
    console.log(
      `  With tools:    ${withTools.input_tokens.toLocaleString()} tokens`,
    );
    console.log(`  Tool overhead: ${toolTokens.toLocaleString()} tokens`);
    console.log(
      `  Per tool avg:  ${Math.round(toolTokens / tools.length)} tokens`,
    );

    // Tools should contribute a meaningful number of tokens
    expect(toolTokens).toBeGreaterThan(1000);
  });

  test("structured content (HTML/XML) tokenizes more densely than 4 chars/token", async () => {
    // Test with HTML-heavy content to measure actual chars/token ratio
    const htmlContent = Array.from(
      { length: 100 },
      (_, i) =>
        `<div class="item-${i}" data-testid="row-${i}"><span class="name">${"Content ".repeat(5)}</span></div>`,
    ).join("\n");

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: htmlContent }] },
    ];
    const systemPrompt = "You are a helpful assistant.";

    const estimated = estimatePromptTokens(messages, systemPrompt, {
      providerName: "anthropic",
    });
    const actual = await countTokensViaApi(systemPrompt, messages);

    const actualCharsPerToken = htmlContent.length / actual.input_tokens;
    const ratio = actual.input_tokens / estimated;

    console.log("=== HTML content tokenization ===");
    console.log(
      `  Content length: ${htmlContent.length.toLocaleString()} chars`,
    );
    console.log(`  Estimated:      ${estimated.toLocaleString()} tokens`);
    console.log(
      `  Actual:         ${actual.input_tokens.toLocaleString()} tokens`,
    );
    console.log(`  Assumed chars/token: 4`);
    console.log(`  Actual chars/token:  ${actualCharsPerToken.toFixed(2)}`);
    console.log(`  Ratio:          ${ratio.toFixed(2)}x`);

    // HTML/XML typically tokenizes at 2-3 chars per token, not 4
    // This means our estimate underestimates HTML-heavy content
    expect(actualCharsPerToken).toBeLessThan(4);
  });

  test("production-scale scenario: old vs new estimator with 160 tools", async () => {
    const systemPrompt = makeSystemPrompt("production");
    const messages = makeConversationMessages();
    const baseTools = makeToolDefinitions() as ToolDefinition[];
    const extraTools = generateBundledSkillTools(123) as ToolDefinition[];
    const tools = [...baseTools, ...extraTools];

    const toolTokenBudget = estimateToolsTokens(tools);

    // Old estimator: no tool awareness
    const oldEstimated = estimatePromptTokens(messages, systemPrompt, {
      providerName: "anthropic",
    });

    // New estimator: includes tool token budget
    const newEstimated = estimatePromptTokens(messages, systemPrompt, {
      providerName: "anthropic",
      toolTokenBudget,
    });

    const actual = await countTokensViaApi(systemPrompt, messages, tools);

    const oldRatio = actual.input_tokens / oldEstimated;
    const newRatio = actual.input_tokens / newEstimated;

    console.log("=== Production-scale scenario (old vs new) ===");
    console.log(`  Tools:          ${tools.length}`);
    console.log(
      `  System:         ${systemPrompt.length.toLocaleString()} chars`,
    );
    console.log(`  Tool budget:    ${toolTokenBudget.toLocaleString()} tokens`);
    console.log(
      `  Old estimated:  ${oldEstimated.toLocaleString()} tokens (ratio ${oldRatio.toFixed(2)}x)`,
    );
    console.log(
      `  New estimated:  ${newEstimated.toLocaleString()} tokens (ratio ${newRatio.toFixed(2)}x)`,
    );
    console.log(
      `  Actual:         ${actual.input_tokens.toLocaleString()} tokens`,
    );
    console.log(`  Production observed: 3.01x (73,416 est vs 220,964 actual)`);

    // Old estimator should have a large gap
    expect(oldRatio).toBeGreaterThan(1.5);
    // New estimator should be significantly better
    expect(newRatio).toBeLessThan(oldRatio);
    // New ratio should be within 50% of actual (allowing for remaining
    // tokenization density gap on structured content)
    expect(newRatio).toBeLessThan(1.5);
  });
});
