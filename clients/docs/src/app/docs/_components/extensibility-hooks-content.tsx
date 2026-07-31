"use client";

import type { Route } from "next";
import Link from "next/link";

import { AgentLoopDiagram } from "@/app/docs/_components/agent-loop-diagram";
import { AssistantLifecycleDiagram } from "@/app/docs/_components/assistant-lifecycle-diagram";
import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "the-lifecycle", label: "The Agent Loop", level: 2 },
  { id: "hooks-reference", label: "Hooks reference", level: 2 },
  { id: "resolution-order", label: "Resolution order", level: 2 },
  { id: "anatomy-of-a-hook", label: "Anatomy of a hook", level: 2 },
  {
    id: "when-to-write-a-hook",
    label: "When should my assistant write a Hook?",
    level: 2,
  },
];

const linkClass =
  "font-semibold text-emerald-700 underline hover:text-emerald-800";

const HOOKS_CONSTANT_URL =
  "https://github.com/vellum-ai/vellum-assistant/blob/main/assistant/src/plugin-api/constants.ts";

const PLUGIN_API_URL =
  "https://github.com/vellum-ai/vellum-assistant/tree/main/assistant/src/plugin-api";

type HookField = {
  name: string;
  type: string;
  mutable: boolean;
  desc: string;
};

type HookReference = {
  name: string;
  context: string;
  when: string;
  can: string;
  fields: HookField[];
  note?: string;
  example?: { label: string; href: string };
};

const HOOK_REFERENCE: HookReference[] = [
  {
    name: "init",
    context: "InitContext",
    when: "Once, when the plugin is first registered (on boot or install).",
    can: "Validate config and open resources. This is where plugin-owned storage is set up: create data files under pluginStorageDir and apply the plugin's own schema, idempotently, since init runs on every boot. Throwing aborts the plugin's load.",
    example: {
      label: "image-fallback",
      href: "https://github.com/vellum-ai/vellum-assistant/blob/main/assistant/src/plugins/defaults/image-fallback/hooks/init.ts",
    },
    fields: [
      {
        name: "config",
        type: "unknown",
        mutable: false,
        desc: "Parsed config for this plugin, read from <pluginDir>/config.json.",
      },
      {
        name: "pluginStorageDir",
        type: "string",
        mutable: false,
        desc: "Absolute path to <pluginDir>/data/, the plugin's writable data directory (created during bootstrap).",
      },
      {
        name: "assistantVersion",
        type: "string",
        mutable: false,
        desc: "Assistant semver, for defensive runtime checks.",
      },
      {
        name: "logger",
        type: "PluginLogger",
        mutable: false,
        desc: "Pino-compatible logger scoped to the plugin.",
      },
    ],
  },
  {
    name: "user-prompt-submit",
    context: "UserPromptSubmitContext",
    when: "Once per user turn, after messages are assembled and before the agent loop runs.",
    can: "Read or rewrite the message list the model is about to see.",
    example: {
      label: "advisor",
      href: "https://github.com/vellum-ai/vellum-assistant/blob/5a79f009573790dd085223a0133135410a6fe41d/assistant/src/plugins/defaults/advisor/hooks/user-prompt-submit.ts",
    },
    fields: [
      {
        name: "conversationId",
        type: "string",
        mutable: false,
        desc: "Conversation the prompt was submitted on.",
      },
      {
        name: "userMessageId",
        type: "string",
        mutable: false,
        desc: "Persisted id of the user message that triggered the turn.",
      },
      {
        name: "requestId",
        type: "string",
        mutable: false,
        desc: "Stable id for the request driving this turn.",
      },
      {
        name: "modelProfileKey",
        type: "string",
        mutable: false,
        desc: "Effective inference profile identity for the model this turn will use. Profileless configs receive the resolved model id.",
      },
      {
        name: "isNonInteractive",
        type: "boolean",
        mutable: false,
        desc: "True when no human is present to answer clarifications (scheduled or headless runs).",
      },
      {
        name: "prompt",
        type: "string",
        mutable: false,
        desc: "Resolved text of the user prompt, after slash-command expansion.",
      },
      {
        name: "originalMessages",
        type: "ReadonlyArray<Message>",
        mutable: false,
        desc: "The user's original message list. Snapshot only, never mutate.",
      },
      {
        name: "latestMessages",
        type: "Message[]",
        mutable: true,
        desc: "The working list that flows into the agent loop. Mutate in place or replace via the return value.",
      },
      {
        name: "logger",
        type: "PluginLogger",
        mutable: false,
        desc: "Logger pre-tagged with the hook name, your plugin, and the conversation / request identity. Log through it; no manual tagging needed.",
        },
        {
          name: "broadcast",
          type: "HookBroadcast",
          mutable: false,
          desc: "Emit a transient `hook_event` to any UI watching the conversation. You supply a JSON-serializable `detail` record; the runtime stamps the conversation, hook name, and owner attribution. Best-effort: never throws or blocks the turn.",
        },
    ],
  },
  {
    name: "post-compact",
    context: "PostCompactContext",
    when: "After the loop compacts a conversation mid-turn, before the turn resumes. It fires on a compaction event rather than a fixed turn boundary, so it branches off the loop rather than sitting on a turn edge.",
    can: "Re-apply context that compaction dropped (for example memory injections) onto the compacted history before the next model call.",
    example: {
      label: "memory-v3-shadow",
      href: "https://github.com/vellum-ai/vellum-assistant/blob/5a79f009573790dd085223a0133135410a6fe41d/assistant/src/plugins/defaults/memory-v3-shadow/hooks/post-compact.ts",
    },
    fields: [
      {
        name: "history",
        type: "Message[]",
        mutable: true,
        desc: "The compacted message history to re-inject onto. The loop resumes the turn from the settled value.",
      },
      {
        name: "requestId",
        type: "string",
        mutable: false,
        desc: "Stable id of the request driving this turn. Forward it onto the injector so re-applied blocks are attributed to the originating request.",
      },
      {
        name: "conversationId",
        type: "string",
        mutable: false,
        desc: "Conversation the turn being compacted is scoped to.",
      },
      {
        name: "isNonInteractive",
        type: "boolean",
        mutable: false,
        desc: "True when no human is present to answer clarifications (scheduled, background, or headless runs).",
      },
      {
        name: "modelProfileKey",
        type: "string",
        mutable: false,
        desc: "Effective inference profile identity for the model the compacted turn will keep using. Profileless configs receive the resolved model id.",
      },
      {
        name: "injectionMode",
        type: '"full" | "minimal"',
        mutable: false,
        desc: "Volume of runtime injection to re-apply. 'full' restores the complete context, 'minimal' is the reduced volume overflow recovery selects. Defaults to 'full'.",
      },
      {
        name: "logger",
        type: "PluginLogger",
        mutable: false,
        desc: "Logger pre-tagged with the hook name, your plugin, and the conversation / request identity. Log through it; no manual tagging needed.",
      },
      {
        name: "broadcast",
        type: "HookBroadcast",
        mutable: false,
        desc: "Emit a transient `hook_event` to any UI watching the conversation. You supply a JSON-serializable `detail` record; the runtime stamps the conversation, hook name, and owner attribution. Best-effort: never throws or blocks the turn.",
      },
    ],
  },
  {
    name: "pre-model-call",
    context: "PreModelCallContext",
    when: "Immediately before every provider call within a turn, including tool-result follow-ups.",
    can: "Edit the outbound request (for example the system prompt), route the call to a chosen inference profile, or defer this turn's live output stream.",
    example: {
      label: "advisor",
      href: "https://github.com/vellum-ai/vellum-assistant/blob/5a79f009573790dd085223a0133135410a6fe41d/assistant/src/plugins/defaults/advisor/hooks/pre-model-call.ts",
    },
    fields: [
      {
        name: "conversationId",
        type: "string",
        mutable: false,
        desc: "Conversation the call belongs to.",
      },
      {
        name: "callSite",
        type: "LLMCallSite | null",
        mutable: false,
        desc: "Which call site this serves (mainAgent for the user-facing reply), or null when not tied to a known site. Self-gate on it before acting.",
      },
      {
        name: "systemPrompt",
        type: "string | null",
        mutable: true,
        desc: "The system prompt about to be sent. Replace it to edit the request; guard the null case.",
      },
      {
        name: "modelProfile",
        type: "string | null",
        mutable: true,
        desc: "The inference profile this call routes to. Set it to a profile key to send the call there (the lever a model-router hook uses to pick a profile per call), or leave it as is for the default resolution. Seeded from the call's resolved override, and null when none applies. Gate on callSite first, and discover the routable keys with getModelProfiles().",
      },
      {
        name: "deferAssistantOutput",
        type: "boolean",
        mutable: true,
        desc: "Set true to suppress the live token stream so a post-model-call hook can emit the final text instead.",
      },
      {
        name: "logger",
        type: "PluginLogger",
        mutable: false,
        desc: "Logger pre-tagged with the hook name, your plugin, and the conversation / request identity. Log through it; no manual tagging needed.",
        },
        {
          name: "broadcast",
          type: "HookBroadcast",
          mutable: false,
          desc: "Emit a transient `hook_event` to any UI watching the conversation. You supply a JSON-serializable `detail` record; the runtime stamps the conversation, hook name, and owner attribution. Best-effort: never throws or blocks the turn.",
        },
    ],
  },
  {
    name: "post-model-call",
    context: "PostModelCallContext",
    when: "At every model-call outcome: a finalized assistant message, or a provider rejection. Fires once per model call, before a finalized reply is persisted and streamed.",
    can: "Transform the reply's text blocks (leave tool_use intact), and own the continue decision. On a degenerate no-tool reply or a recoverable rejection, repair the history and set decision to continue to re-query the model. Use isMaxTokensStopReason() from @vellumai/plugin-api on ctx.stopReason to detect truncated replies that may need continuation.",
    example: {
      label: "advisor",
      href: "https://github.com/vellum-ai/vellum-assistant/blob/5a79f009573790dd085223a0133135410a6fe41d/assistant/src/plugins/defaults/advisor/hooks/post-model-call.ts",
    },
    fields: [
      {
        name: "conversationId",
        type: "string",
        mutable: false,
        desc: "Conversation the message belongs to.",
      },
      {
        name: "callSite",
        type: "LLMCallSite | null",
        mutable: false,
        desc: "Which call site this message serves, or null when not tied to a known site. Self-gate before acting.",
      },
      {
        name: "content",
        type: "ContentBlock[]",
        mutable: true,
        desc: "The finalized message content; empty on a provider rejection. Transform text blocks and leave tool_use intact.",
      },
      {
        name: "messages",
        type: "Message[]",
        mutable: true,
        desc: "Full conversation history. When continuing, leave this as the history the next iteration should send (append a follow-up turn, or replace it with a repaired one).",
      },
      {
        name: "error",
        type: "Error | undefined",
        mutable: false,
        desc: "The provider rejection that ended the call, on a rejection outcome; absent on a finalized reply. Hooks that only act on a real reply should guard on it and return early.",
      },
      {
        name: "stopReason",
        type: "string | null",
        mutable: false,
        desc: "Provider-reported stop reason, or null when none was reported (also null on a rejection).",
      },
      {
        name: "decision",
        type: "PostModelCallDecision",
        mutable: true,
        desc: "Seeded to 'stop'. Set it to 'continue' to re-query the model. Honored only at actionable outcomes (a no-tool reply or a provider rejection); the loop does not gate it on call site, so self-gate via callSite to avoid re-querying background or subagent calls.",
      },
      {
        name: "logger",
        type: "PluginLogger",
        mutable: false,
        desc: "Logger pre-tagged with the hook name, your plugin, and the conversation / request identity. Log through it; no manual tagging needed.",
        },
        {
          name: "broadcast",
          type: "HookBroadcast",
          mutable: false,
          desc: "Emit a transient `hook_event` to any UI watching the conversation. You supply a JSON-serializable `detail` record; the runtime stamps the conversation, hook name, and owner attribution. Best-effort: never throws or blocks the turn.",
        },
    ],
  },
  {
    name: "post-tool-use",
    context: "PostToolUseContext",
    when: "After each tool returns, before the result rejoins the history sent to the provider.",
    can: "Transform the tool result, for example truncating oversized output to fit the context window.",
    example: {
      label: "tool-result-truncate",
      href: "https://github.com/vellum-ai/vellum-assistant/blob/5a79f009573790dd085223a0133135410a6fe41d/assistant/src/plugins/defaults/tool-result-truncate/hooks/post-tool-use.ts",
    },
    fields: [
      {
        name: "conversationId",
        type: "string",
        mutable: false,
        desc: "Conversation the tool ran on.",
      },
      {
        name: "toolResponse",
        type: "ToolResultContent",
        mutable: true,
        desc: "The tool result block. Mutate its content in place or replace the block.",
      },
      {
        name: "messages",
        type: "ReadonlyArray<Message>",
        mutable: false,
        desc: "History up to and including the assistant turn that issued the call. The result is not in it yet.",
      },
      {
        name: "additionalContext",
        type: "string | null",
        mutable: true,
        desc: "Extra model-only guidance appended after the tool result, for example retry coaching. Defaults to null; set a string to append guidance.",
      },
      {
        name: "maxInputTokens",
        type: "number",
        mutable: false,
        desc: "The model's context-window size in tokens, for deriving a character budget.",
      },
      {
        name: "logger",
        type: "PluginLogger",
        mutable: false,
        desc: "Logger pre-tagged with the hook name, your plugin, and the conversation / request identity. Log through it; no manual tagging needed.",
        },
        {
          name: "broadcast",
          type: "HookBroadcast",
          mutable: false,
          desc: "Emit a transient `hook_event` to any UI watching the conversation. You supply a JSON-serializable `detail` record; the runtime stamps the conversation, hook name, and owner attribution. Best-effort: never throws or blocks the turn.",
        },
    ],
  },
  {
    name: "stop",
    context: "StopContext",
    when: "Once per run, when the loop has committed to ending the turn. Fires on every terminal exit (a no-tool reply, max tokens, a yield to the user, exhausted overflow recovery, an abort, or an error) and on a checkpoint handoff.",
    can: "Run teardown: release per-turn resources or clear per-turn state, knowing nothing will re-enter the loop this run. It cannot continue the loop; the retry decision lives in post-model-call.",
    example: {
      label: "max-tokens-continue",
      href: "https://github.com/vellum-ai/vellum-assistant/blob/5a79f009573790dd085223a0133135410a6fe41d/assistant/src/plugins/defaults/max-tokens-continue/hooks/stop.ts",
    },
    fields: [
      {
        name: "conversationId",
        type: "string",
        mutable: false,
        desc: "Conversation the run belongs to.",
      },
      {
        name: "messages",
        type: "ReadonlyArray<Message>",
        mutable: false,
        desc: "Full conversation history at the terminal stop. Provided for inspection; mutating it has no effect, since the loop will not run again this turn.",
      },
      {
        name: "exitReason",
        type: "AgentLoopExitReason",
        mutable: false,
        desc: "Which terminal state the turn reached (for example no_tool_calls, max_tokens_reached, error, checkpoint_handoff). A hook that should act only on a particular ending guards on it.",
      },
      {
        name: "error",
        type: "Error | undefined",
        mutable: false,
        desc: "The rejection that ended the turn, when it ended on one; absent on a clean stop.",
      },
      {
        name: "logger",
        type: "PluginLogger",
        mutable: false,
        desc: "Logger pre-tagged with the hook name, your plugin, and the conversation / request identity. Log through it; no manual tagging needed.",
        },
        {
          name: "broadcast",
          type: "HookBroadcast",
          mutable: false,
          desc: "Emit a transient `hook_event` to any UI watching the conversation. You supply a JSON-serializable `detail` record; the runtime stamps the conversation, hook name, and owner attribution. Best-effort: never throws or blocks the turn.",
        },
    ],
  },
  {
    name: "shutdown",
    context: "ShutdownContext",
    when: "Once, when the Assistant tears down the plugin (process exit, unload).",
    can: "Best-effort cleanup: close storage handles opened in init and release other resources. Do not rely on it for critical writes; persist durably during normal operation instead.",
    example: {
      label: "image-fallback",
      href: "https://github.com/vellum-ai/vellum-assistant/blob/main/assistant/src/plugins/defaults/image-fallback/hooks/shutdown.ts",
    },
    fields: [
      {
        name: "assistantVersion",
        type: "string",
        mutable: false,
        desc: "Assistant semver, for version-conditional cleanup.",
      },
    ],
  },
  {
    name: "conversation-deleted",
    context: "ConversationDeletedContext",
    when: "Once per deleted conversation, after the conversation's rows are removed. Fired from the shared delete primitive, so every caller (route, retrospective cleanup, GC) dispatches it.",
    can: "Clean up per-conversation state: cancel pending background jobs, evict caches, remove external records. The dispatch is fire-and-forget, so hooks run concurrently with whatever the caller does after the delete and must not assume any ordering relative to it.",
    example: {
      label: "memory",
      href: "https://github.com/vellum-ai/vellum-assistant/blob/96643af728e245424e112dd112315c5e75f5d204/assistant/src/plugins/defaults/memory/hooks/conversation-deleted.ts",
    },
    fields: [
      {
        name: "conversationId",
        type: "string",
        mutable: false,
        desc: "ID of the conversation that was deleted. By the time the hook runs the conversation's rows are gone, so key cleanup on this id only.",
      },
      {
        name: "logger",
        type: "PluginLogger",
        mutable: false,
        desc: "Logger pre-tagged with the hook name, your plugin, and the conversation identity. Log through it; no manual tagging needed.",
      },
      {
        name: "broadcast",
        type: "HookBroadcast",
        mutable: false,
        desc: "Emit a transient `hook_event` to any UI watching the conversation. You supply a JSON-serializable `detail` record; the runtime stamps the conversation, hook name, and owner attribution. Best-effort: never throws or blocks the turn.",
      },
    ],
  },
];

export function ExtensibilityHooksContent() {
  return (
    <>
      <DocsContent
        title="Hooks"
        breadcrumb="Docs / Extensibility / Hooks"
        subtitle="Run your own code at fixed points in a turn. Hooks let a plugin read or transform what flows through the Assistant without forking the core loop, and broadcast progress to the UI."
      >
        <p className="mb-8 text-zinc-600 dark:text-zinc-400">
          A hook is a function that the Assistant calls at a known boundary in
          their lifecycle. The harness owns the loop, and your Assistant&apos;s
          code runs at named points along the way. Each hook lives in its own
          file under <code>hooks/&lt;name&gt;.ts</code>, and the filename is the
          hook name.
        </p>

        <section id="the-lifecycle">
          <SectionHeading id="the-lifecycle" level={2}>
            The Agent Loop
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The diagram below maps what we call the <strong>Agent Loop</strong>.
            The nodes are <strong>lifecycle events</strong>: the points in time
            turns of a conversation passes through. The connecting{" "}
            <strong>hooks</strong> are the places your code can run as the turn
            moves from one event to the next.
          </p>

          <AgentLoopDiagram />

          <div className="mb-6 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left">
                  <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                    Node
                  </th>
                  <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                    What it means
                  </th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 font-semibold whitespace-nowrap text-zinc-900 dark:text-zinc-100">
                    User prompt
                  </td>
                  <td className="py-2">
                    The incoming user message that kicks off a turn. The{" "}
                    <code>user-prompt-submit</code> hook fires as the prompt
                    enters the loop.
                  </td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 font-semibold whitespace-nowrap text-zinc-900 dark:text-zinc-100">
                    Context check
                  </td>
                  <td className="py-2">
                    Decides whether the conversation fits within the
                    model&apos;s context window. If it does not, control
                    branches to Compaction before the model is called.
                  </td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 font-semibold whitespace-nowrap text-zinc-900 dark:text-zinc-100">
                    Model call
                  </td>
                  <td className="py-2">
                    The inference request sent to the LLM. The{" "}
                    <code>pre-model-call</code> hook fires immediately before
                    the request is dispatched.
                  </td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 font-semibold whitespace-nowrap text-zinc-900 dark:text-zinc-100">
                    Model response
                  </td>
                  <td className="py-2">
                    The raw output returned by the model. The{" "}
                    <code>post-model-call</code> hook fires here, and the loop
                    branches based on what the model returned: a tool call, a
                    continuation, a stop, or a context error.
                  </td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 font-semibold whitespace-nowrap text-zinc-900 dark:text-zinc-100">
                    Assistant reply
                  </td>
                  <td className="py-2">
                    The final message delivered to the user. The{" "}
                    <code>stop</code> hook fires just before the reply is sent,
                    marking the end of the turn.
                  </td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4 font-semibold whitespace-nowrap text-zinc-900 dark:text-zinc-100">
                    Compaction
                  </td>
                  <td className="py-2">
                    Summarizes or truncates older conversation history so the
                    context fits within the model&apos;s window. The{" "}
                    <code>post-compact</code> hook fires after compaction, and
                    control returns to the Model call node.
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 font-semibold whitespace-nowrap text-zinc-900 dark:text-zinc-100">
                    Tool result
                  </td>
                  <td className="py-2">
                    The output of a tool execution. The{" "}
                    <code>post-tool-use</code> hook fires here, and the result
                    loops back to the merge junction for another model call.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            The loop can iterate several times within a single user turn: every
            tool result returns to a fresh model call, and a{" "}
            <code>post-model-call</code> hook can choose to continue rather than
            end the turn. Because of this, <code>pre-model-call</code>,{" "}
            <code>post-model-call</code>, and <code>post-tool-use</code> can
            each fire more than once per turn.
          </p>

          <SectionHeading id="the-assistant-lifecycle" level={3}>
            The Assistant Lifecycle
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The Assistant can also hook into Lifecycle Events that sit outside
            the Agent Loop. The diagram below shows where these hooks sit and
            how they interplay with the Server that manages the Agent Loop.
          </p>

          <AssistantLifecycleDiagram />

          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Beyond the session boundaries, the <code>conversation-deleted</code>{" "}
            hook fires as a persistence-lifecycle event: when a conversation is
            removed, every plugin keeping per-conversation state (caches,
            queued jobs, external records) gets a cleanup signal keyed on the
            conversation id. It dispatches fire-and-forget from the shared
            delete primitive, so it applies to every deletion path.
          </p>
        </section>

        <section id="hooks-reference" className="mt-12">
          <SectionHeading id="hooks-reference" level={2}>
            Hooks reference
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            These are the lifecycle hooks this guide covers. The full set of
            wired hook names lives in the{" "}
            <Link href={HOOKS_CONSTANT_URL} className={linkClass}>
              <code>HOOKS</code> constant
            </Link>
            . Expand a hook to see its Context API contract.
          </p>

          <div className="mb-4">
            {HOOK_REFERENCE.map((hook) => (
              <details
                key={hook.name}
                className="mb-3 rounded-lg border border-zinc-200 dark:border-zinc-700"
              >
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
                  <code className="font-semibold text-zinc-900 dark:text-zinc-100">
                    {hook.name}
                  </code>
                  <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
                    {hook.context}
                  </span>
                </summary>
                <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
                  <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">
                    <strong className="text-zinc-900 dark:text-zinc-100">
                      When:
                    </strong>{" "}
                    {hook.when}
                  </p>
                  <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
                    <strong className="text-zinc-900 dark:text-zinc-100">
                      Use it to:
                    </strong>{" "}
                    {hook.can}
                  </p>
                  {hook.example ? (
                    <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
                      <strong className="text-zinc-900 dark:text-zinc-100">
                        Example:
                      </strong>{" "}
                      <Link
                        href={hook.example.href as Route}
                        className="font-mono text-xs text-emerald-600 underline hover:text-emerald-800 dark:text-emerald-400"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {hook.example.label}
                      </Link>
                    </p>
                  ) : null}
                  {hook.note ? (
                    <p className="mb-0 text-sm text-zinc-600 dark:text-zinc-400">
                      <strong className="text-zinc-900 dark:text-zinc-100">
                        Note:
                      </strong>{" "}
                      {hook.note}
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-sm">
                        <thead>
                          <tr className="border-b border-zinc-200 text-left dark:border-zinc-700">
                            <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                              Field
                            </th>
                            <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                              Type
                            </th>
                            <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                              Access
                            </th>
                            <th className="py-2 font-semibold text-zinc-900 dark:text-zinc-100">
                              Description
                            </th>
                          </tr>
                        </thead>
                        <tbody className="text-zinc-600 dark:text-zinc-400">
                          {hook.fields.map((field) => (
                            <tr
                              key={field.name}
                              className="border-b border-zinc-100 align-top dark:border-zinc-800"
                            >
                              <td className="py-2 pr-4">
                                <code>{field.name}</code>
                              </td>
                              <td className="py-2 pr-4">
                                <code className="text-zinc-500 dark:text-zinc-400">
                                  {field.type}
                                </code>
                              </td>
                              <td className="py-2 pr-4 whitespace-nowrap">
                                {field.mutable ? "Mutable" : "Read-only"}
                              </td>
                              <td className="py-2">{field.desc}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </details>
            ))}
          </div>

          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            When several plugins register hooks for the same boundary, they
            chain: each hook sees the previous hook&apos;s changes, and the
            merged result flows into the next. The order is deterministic.
          </p>
        </section>

        <section id="resolution-order" className="mt-12">
          <SectionHeading id="resolution-order" level={2}>
            Resolution order
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            When multiple plugins define the same hook, they execute in a fixed
            order so the chain is predictable:
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                Built-in default plugins
              </strong>
              . Registered explicitly at startup. They always run first, so
              their context transformations are visible to every user plugin
              after them.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                User plugins
              </strong>
              . Ordered by the plugin&apos;s original install date, the{" "}
              <code>installedAt</code> timestamp from the{" "}
              <code>install-meta.json</code> sidecar written at install time.
              Plugins installed earlier run first. Plugins without a sidecar
              fall back to the directory creation time and sort after dated
              ones.
            </li>
          </ol>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Within a single plugin, hooks for the same name are not duplicated:
            each plugin contributes at most one hook per boundary. The chain is
            linear: the output of hook <em>N</em> is the input of hook{" "}
            <em>N+1</em>, and the final output is what the Assistant acts on.
          </p>
        </section>

        <section id="anatomy-of-a-hook" className="mt-12">
          <SectionHeading id="anatomy-of-a-hook" level={2}>
            Anatomy of a hook
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Every hook has the same shape: it receives a typed context and
            either mutates it in place and returns nothing, or returns a{" "}
            <strong>partial</strong> context. A returned partial is merged onto
            the threaded context &mdash; only the keys it includes are
            overwritten, every other field is preserved &mdash; so a hook can
            edit just the subset of fields it cares about without re-specifying
            the rest. The runtime threads the merged context to the next plugin
            and then to the Assistant.
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`type HookFunction<TCtx> = (ctx: TCtx) => Promise<Partial<TCtx> | void>;`}</code>
          </pre>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Because an omitted key means &ldquo;keep the existing value&rdquo;,
            every context field is required and uses <code>| null</code> rather
            than <code>?</code> or <code>| undefined</code>: a present key
            always carries a concrete value, so a field absent from a returned
            partial is never ambiguous with one a hook meant to clear.
          </p>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            One hook per file, default-exported. The filename becomes the hook
            key, so a <code>pre-model-call</code> hook is{" "}
            <code>hooks/pre-model-call.ts</code>:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`// hooks/pre-model-call.ts
import type { PreModelCallContext } from "@vellumai/plugin-api";

export default async function preModelCall(
  ctx: PreModelCallContext,
): Promise<void> {
  // Only touch the user-facing reply, not background or subagent calls.
  if (ctx.callSite !== "mainAgent") {
    return;
  }
  ctx.systemPrompt = (ctx.systemPrompt ?? "") + "\\nBe concise.";
}`}</code>
          </pre>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Context types and constants come from{" "}
            <Link href={PLUGIN_API_URL} className={linkClass}>
              <code>@vellumai/plugin-api</code>
            </Link>
            , the only supported contract.
          </p>
        </section>

        <section id="when-to-write-a-hook" className="mt-12">
          <SectionHeading id="when-to-write-a-hook" level={2}>
            When should my assistant write a Hook?
          </SectionHeading>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Reach for a hook when you need to read or transform what flows
            through a turn at a fixed point in the loop, regardless of what the
            model decides. Hooks are unconditional: rewrite the prompt before
            the model sees it, route a call to a different model, truncate an
            oversized tool result, re-inject context after compaction. If the
            behavior has to happen every time the loop reaches that boundary, it
            is a hook.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
