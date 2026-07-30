"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";
import { routes } from "@/lib/routes";

const TOC_ITEMS = [
  { id: "directory-layout", label: "Directory layout", level: 2 },
  { id: "preserved-entries", label: "Preserved entries", level: 3 },
  { id: "state-is-plugin-owned", label: "State is plugin-owned", level: 3 },
  { id: "the-manifest", label: "The manifest", level: 2 },
  { id: "the-plugin-api", label: "The @vellumai/plugin-api surface", level: 2 },
  {
    id: "surfaces-not-yet-in-plugins",
    label: "Surfaces not yet in plugins",
    level: 2,
  },
  {
    id: "when-to-write-a-plugin",
    label: "When should my assistant write a Plugin?",
    level: 2,
  },
];

const linkClass =
  "font-semibold text-emerald-700 underline hover:text-emerald-800";

const PLUGIN_API_URL =
  "https://github.com/vellum-ai/vellum-assistant/tree/main/assistant/src/plugin-api";

const HOOKS_PAGE_URL = "/docs/extensibility/hooks";
const TOOLS_PAGE_URL = "/docs/extensibility/tools";

type ApiExport = {
  name: string;
  kind: "type" | "value" | "const" | "enum";
  desc: string;
};

type ApiGroup = {
  id: string;
  title: string;
  summary: string;
  exports: ApiExport[];
};

const API_GROUPS: ApiGroup[] = [
    {
      id: "logging",
      title: "Logging",
      summary:
        "The logger the host threads onto the contexts. Log through it rather than rolling your own.",
      exports: [
        {
          name: "PluginLogger",
          kind: "type",
          desc: "Pino-compatible logger shape present on the contexts. On agent-loop hook contexts it is bound per hook, pre-tagged with the hook name, your plugin, and the conversation / request identity when the context carries them, so no manual { plugin } tagging is needed. On InitContext it is bound to { plugin: <name> }.",
        },
      ],
    },
    {
      id: "events",
      title: "Events",
      summary:
        "Pub/sub hub for runtime events, letting a plugin react to activity outside the hook chain.",
      exports: [
        {
          name: "assistantEventHub",
          kind: "value",
          desc: "The assistant's pub/sub hub for runtime events. Subscribe to react to activity outside the hook chain.",
        },
        {
          name: "AssistantEvent",
          kind: "type",
          desc: "Payload shape of an event published on the hub.",
        },
        {
          name: "AssistantEventHub",
          kind: "type",
          desc: "Interface of the event hub itself.",
        },
        {
          name: "AssistantEventCallback",
          kind: "type",
          desc: "Subscriber callback invoked for each matching event.",
        },
        {
          name: "AssistantEventFilter",
          kind: "type",
          desc: "Filter narrowing which events a subscription receives.",
        },
        {
          name: "AssistantEventSubscription",
          kind: "type",
          desc: "Handle returned by subscribing, used to unsubscribe.",
        },
      ],
    },
    {
      id: "model-routing",
      title: "Model routing",
      summary:
        "Discover inference profiles, check vision capability, and resolve a provider to run model calls through the workspace's stored credentials.",
      exports: [
        {
          name: "getModelProfiles",
          kind: "value",
          desc: "List this workspace's inference profiles in /model picker order, so a routing plugin can learn which profile keys exist before assigning one to PreModelCallContext.modelProfile. Reads live config, so call it at init to build a map once or per call.",
        },
        {
          name: "doesSupportVision",
          kind: "value",
          desc: "Check whether a profile's resolved model can process image input. Takes a ModelProfileInfo entry from getModelProfiles() and resolves the effective (provider, model) by merging the profile over the workspace default and inferring the provider for model-only profiles. Handles mix profiles (true if any arm supports vision). Unknown models default to true (fail-open). Use this to gate image-processing logic on capability rather than model name strings.",
        },
        {
          name: "getConfiguredProvider",
          kind: "value",
          desc: "Resolve a provider instance for a call site (typically 'inference'), optionally overriding the profile. Returns null when no provider is configured. A plugin that needs to run its own model call (e.g. captioning an image with a vision model) uses this to route through the workspace's credentials without supplying its own API key. Pair with getModelProfiles() and doesSupportVision() to pick the right profile.",
        },
        {
          name: "ModelProfileInfo",
          kind: "type",
          desc: "Shape of each entry getModelProfiles() returns: key, label, description, isActive, isDisabled, and isMix. Disabled profiles and weighted mix profiles are included and flagged; a mix is a valid target that splits the call across its constituents per conversation.",
        },
      ],
    },
    {
      id: "credentials",
      title: "Credentials",
      summary:
        "Resolve stored credentials to plaintext at runtime, scoped to the calling plugin's manifest name.",
      exports: [
        {
          name: "resolveCredential",
          kind: "value",
          desc: "Resolve a stored credential to its plaintext value (the same value `assistant credentials reveal` prints) from a UUID or a \"service/field\" reference. When a plugin is in context, resolution is scoped to credentials whose `field` matches the plugin's manifest name; outside any plugin it is unscoped. Throws CredentialResolutionError when the ref does not resolve, the store is unreachable, or the credential is out of the plugin's scope.",
        },
        {
          name: "CredentialResolutionError",
          kind: "value",
          desc: "Error class thrown when credential resolution fails (ref not found, store unreachable, or out of scope). Catch it to degrade gracefully rather than crashing the hook.",
        },
      ],
    },
    {
      id: "inference-helpers",
      title: "Inference helpers",
      summary:
        "Utilities for working with model inputs and outputs: media resolution and stop-reason classification.",
      exports: [
        {
          name: "resolveMediaSourceData",
          kind: "value",
          desc: "Resolve an image or file content block's `source` to inline base64 bytes, whether the source is inline base64 or a persisted workspace reference (attachment-store row or a file on disk). Returns null when a reference can no longer be resolved. Use this to normalize media before passing it to a provider call.",
        },
        {
          name: "isMaxTokensStopReason",
          kind: "value",
          desc: "Classify a provider stop reason: true when the turn was truncated at the output token cap (vs. a natural stop or a tool call). A post-model-call hook reads it off PostModelCallContext.stopReason to decide whether to continue a cut-off reply. See the Hooks page for the post-model-call context.",
        },
      ],
    },
    {
      id: "identity",
      title: "Identity",
      summary:
        "Read the assistant and user display names, so a plugin that builds its own prompts can name the actors without hardcoding strings.",
      exports: [
        {
          name: "getAssistantName",
          kind: "value",
          desc: "Read the assistant's display name from the workspace IDENTITY.md. Returns null when unset. A plugin that builds its own prompts (e.g. for its own inference) uses this to name the assistant actor.",
        },
        {
          name: "resolveUserName",
          kind: "value",
          desc: "Read the user's display name from the user profile under the given workspace directory. Returns null when unset. Pair with getAssistantName to populate identity fields in custom prompts.",
        },
      ],
    },
    {
      id: "embeddings",
      title: "Embeddings",
      summary:
        "Host-resolved operations on the shared embedding and vector-store subsystem. Each reads live workspace config internally, so plugins hold no config. Async because the facade loads the embed graph lazily on first call.",
      exports: [
        {
          name: "embedAndUpsert",
          kind: "value",
          desc: "Embed a text or multimodal input and upsert the vector into the host's vector store. Returns the embedding and the upserted id.",
        },
        {
          name: "selectedBackendSupportsMultimodal",
          kind: "value",
          desc: "Check whether the currently selected embedding backend supports multimodal input (text + image). Gate multimodal embedding logic on this rather than assuming a specific backend.",
        },
      ],
    },
    {
      id: "skills-catalog",
      title: "Skills catalog",
      summary:
        "List installed and remote-catalog skills with resolved states. Host-resolved: catalog load, install-state resolution, feature-flag gating, and install-meta reads are composed internally. Async because the facade loads lazily on first call.",
      exports: [
        {
          name: "listCatalogSkills",
          kind: "value",
          desc: "List the remote skill catalog with resolved states. Use this to discover skills available for installation.",
        },
        {
          name: "listInstalledSkills",
          kind: "value",
          desc: "List installed skills with install-state resolution. Use this to enumerate what is already available on the workspace.",
        },
        {
          name: "ResolvedSkillEntry",
          kind: "type",
          desc: "Shape of each entry returned by both list functions: name, display name, description, installed state, and metadata.",
        },
      ],
    },
    {
      id: "message-content",
      title: "Message content projections",
      summary:
        "Pure projections of the persisted message content format (a JSON content-block array) to a string, so plugins that read conversation history stay agnostic to how content is persisted.",
      exports: [
        {
          name: "stringifyMessageContent",
          kind: "value",
          desc: "Extract spoken text only from stored content (text blocks; tool calls/results, thinking, and media are dropped). Use this when you need the human-readable reply text.",
        },
        {
          name: "extractTextFromStoredMessageContent",
          kind: "value",
          desc: "Render the full annotated transcript (tool calls with inputs, tool results, thinking, image/file markers). Use this when you need the complete structured view of a message.",
        },
      ],
    },
    {
      id: "conversation-history",
      title: "Conversation history",
      summary:
        "Reads and writes on the host conversation store (rows, message history, processing state, disk-view paths) plus the lexical message-search surface. Every operation takes explicit parameters; nothing is resolved from config. Async because the facade loads the DB store graph lazily on first call.",
      exports: [
        {
          name: "addMessage",
          kind: "value",
          desc: "Append a message to a conversation. Provide the conversation id, role, content, and optional metadata.",
        },
        {
          name: "buildMessageExcerpt",
          kind: "value",
          desc: "Build a short text excerpt from a message, for display or logging.",
        },
        {
          name: "deleteConversation",
          kind: "value",
          desc: "Delete a conversation and all its messages. Fires the conversation-deleted hook.",
        },
        {
          name: "getConversation",
          kind: "value",
          desc: "Get a conversation's metadata row by id. Returns null when not found.",
        },
        {
          name: "getConversationDirPath",
          kind: "value",
          desc: "Get the on-disk directory path for a conversation's persisted files.",
        },
        {
          name: "getMessages",
          kind: "value",
          desc: "Get all messages for a conversation, in order.",
        },
        {
          name: "hasLexicalTokens",
          kind: "value",
          desc: "Check whether a string contains lexical search tokens (useful before calling searchMessageIdsLexical).",
        },
        {
          name: "isConversationProcessing",
          kind: "value",
          desc: "Check whether a conversation is currently running an agent loop. Use this to gate plugins that should not fire while a turn is in progress.",
        },
        {
          name: "listConversations",
          kind: "value",
          desc: "List all conversations with their metadata rows.",
        },
        {
          name: "parseMessageMetadata",
          kind: "value",
          desc: "Parse the metadata JSON on a stored message into a typed object.",
        },
        {
          name: "searchMessageIdsLexical",
          kind: "value",
          desc: "Lexical search over message content, returning matching message ids. Use hasLexicalTokens first to short-circuit on empty queries.",
        },
        {
          name: "syncMessageToDisk",
          kind: "value",
          desc: "Persist a single message to the conversation's on-disk directory.",
        },
        {
          name: "updateMessageMetadata",
          kind: "value",
          desc: "Update the metadata on a stored message.",
        },
        {
          name: "ConversationRow",
          kind: "type",
          desc: "Shape of a conversation metadata row: id, title, created/updated timestamps, and processing state.",
        },
      ],
    },
    {
      id: "text-to-speech",
      title: "Text-to-speech",
      summary:
        "Synthesize text to speech through the assistant's globally configured TTS provider. A plugin that needs voice output uses this instead of managing TTS credentials and provider config.",
      exports: [
        {
          name: "synthesizeText",
          kind: "value",
          desc: "Synthesize text to speech through the assistant's globally configured TTS provider (ElevenLabs, Fish Audio, etc.). Returns a TtsSynthesisResult (Buffer + MIME type). Text is sanitized internally (markdown/URLs/emoji stripped), so callers can pass raw model output directly.",
        },
        {
          name: "TtsSynthesisError",
          kind: "value",
          desc: "Error class thrown when TTS synthesis fails (provider error, network, config). Catch it to degrade gracefully.",
        },
        {
          name: "SynthesizeTextOptions",
          kind: "type",
          desc: "Options for synthesizeText: voice id, speed, and other provider-specific knobs.",
        },
        {
          name: "TtsSynthesisResult",
          kind: "type",
          desc: "Return shape of synthesizeText: { audio: Buffer, mimeType: string }.",
        },
      ],
    },
    {
      id: "conversation-turns",
      title: "Conversation turns",
      summary:
        "Run a full conversation turn (persist, agent loop, compaction, injections, return). Plugins that need to drive conversation turns should prefer this over the stateless provider.sendMessage() call.",
      exports: [
        {
          name: "runConversationTurn",
          kind: "value",
          desc: "Run a full conversation turn (persist user message, execute the agent loop with history/tools/compaction/injections, return the assistant's full content-block response). Accepts ContentBlock[] input (text, images, files) and an optional conversation id (creates a new conversation when omitted). Plugins that need to drive conversation turns (e.g. a meeting bot flushing a transcript excerpt) should prefer this over the stateless provider.sendMessage() call.",
        },
        {
          name: "RunConversationTurnOptions",
          kind: "type",
          desc: "Options for runConversationTurn: input content blocks, conversation id, and turn parameters.",
        },
        {
          name: "RunConversationTurnResult",
          kind: "type",
          desc: "Return shape of runConversationTurn: the assistant's response as ContentBlock[].",
        },
      ],
    },
    {
      id: "cli-data",
      title: "CLI data",
      summary:
        "Declarative help data for the assistant CLI commands. Pure data that a plugin can read to surface CLI capabilities without importing the CLI action graph.",
      exports: [
        {
          name: "CLI_COMMAND_HELP",
          kind: "value",
          desc: "Declarative help data for the top-level `assistant` CLI commands that have adopted the static-help split. Pure data: iterate the fields directly. A plugin that surfaces CLI capabilities (e.g. a capability indexer) reads this instead of importing the CLI action graph.",
        },
      ],
    },
  ];

const LOADER_RULES: { label: string; detail: string }[] = [
  {
    label: "Compiled files win.",
    detail:
      "When both a .js and a .ts exist for the same basename, the .js is used, matching compiled-binary semantics. Clean stale .js files when iterating on .ts source, or the loader will silently pick up old code.",
  },
  {
    label: "Missing directories are skipped.",
    detail:
      "A plugin contributes only the surfaces it ships. Absent surface directories are silently omitted.",
  },
  {
    label: "A broken surface file fails only itself.",
    detail:
      "A surface file present but missing a usable default export is logged with attribution and skipped. Sibling plugins keep loading.",
  },
  {
    label: "src/ is yours.",
    detail:
      "Only the named surface directories are walked. Put shared helpers in src/ (or any other directory) and import from them normally.",
  },
  {
    label: "Loading is time-boxed.",
    detail:
      "Each plugin has a 10s import budget. Anything slower is treated as a load failure and the plugin is skipped.",
  },
];

const kindLabel: Record<ApiExport["kind"], string> = {
  type: "type",
  value: "value",
  const: "const",
  enum: "enum",
};

export function ExtensibilityPluginsContent() {
  return (
    <>
      <DocsContent
        title="Plugins"
        breadcrumb="Docs / Extensibility / Plugins"
        subtitle="A plugin is a directory whose package.json is the manifest and whose subdirectories are the surfaces it contributes. This page covers that layout and the single public package every surface imports from."
      >
        <p className="mb-8 text-zinc-600 dark:text-zinc-400">
          To browse and install ready-made plugins, visit the{" "}
          <a href={routes.plugins} className={linkClass}>
            plugin marketplace
          </a>
          .
        </p>
        <p className="mb-8 text-zinc-600 dark:text-zinc-400">
          The other pages in this section cover each surface on its own. This
          page is the glue: how those surfaces sit together in one directory,
          what the manifest declares, and what a plugin is allowed to import
          from the host.
        </p>

        <section id="directory-layout">
          <SectionHeading id="directory-layout" level={2}>
            Directory layout
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            A plugin lives at{" "}
            <code>&lt;workspaceDir&gt;/plugins/&lt;name&gt;/</code>. The host
            introspects the directory at load time: the manifest names the
            plugin, and each named subdirectory is discovered by convention.
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`my-plugin/
├── package.json               # Manifest (required)
├── README.md                  # Optional plugin docs
├── config.json                # User-editable config (preserved across upgrades)
├── data/                      # Runtime data directory (preserved across upgrades)
├── hooks/                     # Lifecycle hooks, one per file
│   ├── init.ts
│   └── pre-model-call.ts
├── tools/                     # Model-visible tools, one per file
│   └── example.ts
├── routes/                    # HTTP routes, served under /x/plugins/<name>/
│   └── status.ts
├── apps/                      # Interactive apps served in the workspace panel
│   └── dashboard/
│       └── src/
│           └── main.tsx
├── skills/                    # On-demand instruction bundles
│   └── my-skill/
│       └── SKILL.md
└── src/                       # Internal modules (NOT walked by the loader)
  └── state.ts`}</code>
          </pre>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            A few rules govern how the loader walks that tree:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            {LOADER_RULES.map((rule) => (
              <li key={rule.label}>
                <strong className="text-zinc-900 dark:text-zinc-100">
                  {rule.label}
                </strong>{" "}
                {rule.detail}
              </li>
            ))}
          </ul>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Each surface can also be dropped straight into the workspace at{" "}
            <code>/workspace/&lt;surface&gt;/&lt;name&gt;/</code> without
            wrapping it in a plugin. A plugin is what lets you ship several
            surfaces together as one installable unit.
          </p>

          <div id="preserved-entries" className="mt-8">
            <SectionHeading id="preserved-entries" level={3}>
              Preserved entries
            </SectionHeading>
            <p className="mb-4 text-zinc-600 dark:text-zinc-400">
              Three entries at the plugin root are runtime-owned state, not
              part of the plugin&apos;s source tree. They are excluded from
              fingerprinting, drift detection, and upgrades, so user edits and
              runtime data never show as drift and survive re-installs:
            </p>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left dark:border-zinc-700">
                    <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                      Entry
                    </th>
                    <th className="py-2 font-semibold text-zinc-900 dark:text-zinc-100">
                      Purpose
                    </th>
                  </tr>
                </thead>
                <tbody className="text-zinc-600 dark:text-zinc-400">
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4">
                      <code>config.json</code>
                    </td>
                    <td className="py-2">
                      User-editable plugin config. Read by the{" "}
                      <code>init</code> hook via{" "}
                      <code>InitContext.config</code>. Ship a default in your
                      repo; users edit it in place.
                    </td>
                  </tr>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4">
                      <code>data/</code>
                    </td>
                    <td className="py-2">
                      Runtime data directory. The <code>init</code> hook
                      receives its path via{" "}
                      <code>InitContext.pluginStorageDir</code>. Write
                      whatever you want here.
                    </td>
                  </tr>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4">
                      <code>.disabled</code>
                    </td>
                    <td className="py-2">
                      Sentinel file created by{" "}
                      <code>assistant plugins disable</code>. Presence skips
                      the plugin entirely (no hooks, no tools).
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mb-0 mt-4 text-zinc-600 dark:text-zinc-400">
              Uninstalling a plugin removes the entire plugin directory, so{" "}
              <code>config.json</code>, <code>data/</code>, and{" "}
              <code>.disabled</code> go with it. No orphaned state is left
              behind.
            </p>
          </div>

          <div id="state-is-plugin-owned" className="mt-8">
            <SectionHeading id="state-is-plugin-owned" level={3}>
              State is plugin-owned
            </SectionHeading>
            <p className="mb-4 text-zinc-600 dark:text-zinc-400">
              A plugin must be fully self-contained: every byte of durable
              state it keeps lives in <code>data/</code>, and its lifecycle
              hooks own that state end-to-end.
            </p>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
              <li>
                <strong className="text-zinc-900 dark:text-zinc-100">
                  Create in <code>init</code>.
                </strong>{" "}
                Open storage files (e.g. a SQLite database under{" "}
                <code>pluginStorageDir</code>) and apply the plugin&apos;s own
                schema in the <code>init</code> hook. Make it idempotent,
                because <code>init</code> runs on every assistant boot:{" "}
                <code>CREATE TABLE IF NOT EXISTS</code> plus in-place schema
                checks, not one-shot migrations.
              </li>
              <li>
                <strong className="text-zinc-900 dark:text-zinc-100">
                  Close in <code>shutdown</code>.
                </strong>{" "}
                Release storage handles so shutdown and in-place plugin
                redeploys never leak them.
              </li>
              <li>
                <strong className="text-zinc-900 dark:text-zinc-100">
                  Purge in <code>conversation-deleted</code>.
                </strong>{" "}
                Key per-conversation rows by conversation id and delete them
                when the hook fires, so data derived from a conversation does
                not outlive it.
              </li>
            </ul>
            <p className="mb-0 text-zinc-600 dark:text-zinc-400">
              The assistant&apos;s own database is internal:{" "}
              <code>@vellumai/plugin-api</code> exposes no handle to it, and a
              plugin must not persist state elsewhere in the workspace.
              Keeping everything in <code>data/</code> is also what makes
              uninstall clean: removing the plugin directory removes all of
              its state.
            </p>
          </div>
        </section>

        <section id="the-manifest" className="mt-12">
          <SectionHeading id="the-manifest" level={2}>
            The manifest
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Every plugin has a <code>package.json</code>. The loader reads three
            fields and passes everything else through untouched, so your editor,
            linter, and publish tooling keep working as normal.
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`{
  "name": "@you/my-plugin",
  "version": "0.0.1",
  "peerDependencies": {
    "@vellumai/plugin-api": "^0.8.0"
  },
  "vellum": {}
}`}</code>
          </pre>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                <code>name</code>
              </strong>{" "}
              (required). Any npm-style name. The loader strips the scope (
              <code>@you/</code>) for the in-runtime plugin name, and duplicate
              names fail registration. The unscoped portion must be kebab-case
              (e.g. <code>my-plugin</code>, not <code>myPlugin</code> or{" "}
              <code>my_plugin</code>), matching the convention used for catalog
              entries and directory names. The <code>default-</code> prefix is
              reserved for the first-party plugins that ship with the Assistant,
              so installing a plugin whose unscoped name starts with{" "}
              <code>default-</code> is rejected.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                <code>version</code>
              </strong>
              . Informational, and defaults to <code>0.0.0</code> when absent.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                <code>peerDependencies[&quot;@vellumai/plugin-api&quot;]</code>
              </strong>
              . A semver range checked against the running assistant. While
              plugins are in beta a mismatch is logged but does not block load.
              Once the install path stabilizes the mismatch will harden into a
              hard reject, so pin a real range.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-100">
                <code>vellum</code>
              </strong>
              . Reserved for future use.
            </li>
          </ul>
          <p className="mb-0 mt-4 text-zinc-600 dark:text-zinc-400">
            The marketplace catalog entry can point at a subdirectory of a repo
            using <code>source.path</code> in the catalog manifest. See the{" "}
            <Link href={"/docs/extensibility/distribution"} className={linkClass}>
              Distribution page
            </Link>{" "}
            for the full <code>source.path</code> field and the catalog manifest
            schema.
          </p>
        </section>

        <section id="the-plugin-api" className="mt-12">
          <SectionHeading id="the-plugin-api" level={2}>
            The @vellumai/plugin-api surface
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Plugins import everything they need from a single package,{" "}
            <Link href={PLUGIN_API_URL} className={linkClass}>
              <code>@vellumai/plugin-api</code>
            </Link>
            . It is the only supported contract: anything not exported from
            there is assistant-internal and can change without notice. Most of
            the surface is types (the contexts the host hands your code), with a
            small set of runtime handles that resolve to the assistant&apos;s
            live singletons. The hook-related exports (context types,{" "}
              <code>HOOKS</code> constant, <code>HookFunction</code>{" "}
              signature) are documented on the{" "}
            <Link href={HOOKS_PAGE_URL} className={linkClass}>
              Hooks page
            </Link>
            , and the tool-related exports (<code>ToolDefinition</code>,{" "}
            <code>ToolContext</code>, <code>ToolExecutionResult</code>,{" "}
            <code>RiskLevel</code>) are on the{" "}
            <Link href={TOOLS_PAGE_URL} className={linkClass}>
              Tools page
            </Link>
            . The remaining exports are listed below. Expand a group to see what
            it exports.
          </p>

          <div className="mb-4">
            {API_GROUPS.map((group) => (
              <details
                key={group.id}
                className="mb-3 rounded-lg border border-zinc-200 dark:border-zinc-700"
              >
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                    {group.title}
                  </span>
                  <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
                    {group.exports.length} exports
                  </span>
                </summary>
                <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
                  <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
                    {group.summary}
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-zinc-200 text-left dark:border-zinc-700">
                          <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                            Export
                          </th>
                          <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                            Kind
                          </th>
                          <th className="py-2 font-semibold text-zinc-900 dark:text-zinc-100">
                            Purpose
                          </th>
                        </tr>
                      </thead>
                      <tbody className="text-zinc-600 dark:text-zinc-400">
                        {group.exports.map((api) => (
                          <tr
                            key={api.name}
                            className="border-b border-zinc-100 align-top dark:border-zinc-800"
                          >
                            <td className="py-2 pr-4">
                              <code>{api.name}</code>
                            </td>
                            <td className="py-2 pr-4 whitespace-nowrap">
                              <code className="text-zinc-500 dark:text-zinc-400">
                                {kindLabel[api.kind]}
                              </code>
                            </td>
                            <td className="py-2">{api.desc}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </details>
            ))}
          </div>
        </section>

        <section id="surfaces-not-yet-in-plugins" className="mt-12">
          <SectionHeading id="surfaces-not-yet-in-plugins" level={2}>
            Surfaces not yet in plugins
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The assistant supports these surfaces today, but they are not yet
            contributed through the plugin system. They may be added in the
            future.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left dark:border-zinc-700">
                  <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                    Surface
                  </th>
                  <th className="py-2 font-semibold text-zinc-900 dark:text-zinc-100">
                    What it does
                  </th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                {[
                  [
                    "Schedules",
                    "Cron-style triggers that fire on a recurring schedule.",
                  ],
                  [
                    "Artifacts",
                    "Versioned outputs the assistant produces and tracks (documents, diagrams, generated files).",
                  ],
                  [
                    "Webhooks",
                    "Inbound HTTP endpoints that deliver external events into the assistant.",
                  ],
                  [
                    "Prompts",
                    "Reusable system prompt fragments and templates.",
                  ],
                  [
                    "UIs",
                    "Custom UI surfaces rendered in the conversation or workspace.",
                  ],
                  ["Bin", "CLI commands the assistant exposes as tools."],
                  [
                    "Integrations",
                    "OAuth-connected and MCP-connected external services (Google, Linear, Slack, etc.) with credential management.",
                  ],
                  [
                    "Slash commands",
                    "Shortcuts triggered by typing / in the conversation, expanding into prompts or actions.",
                  ],
                  [
                    "Agents",
                    "Delegated sub-agents with scoped roles, tools, and context windows.",
                  ],
                  [
                    "Workflows",
                    "Multi-step automated processes that chain tools, hooks, and model calls into reusable pipelines.",
                  ],
                ].map(([name, desc]) => (
                  <tr
                    key={name}
                    className="border-b border-zinc-100 dark:border-zinc-800"
                  >
                    <td className="py-2 pr-4 font-mono text-zinc-900 dark:text-zinc-100">
                      {name}
                    </td>
                    <td className="py-2">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section id="when-to-write-a-plugin" className="mt-12">
          <SectionHeading id="when-to-write-a-plugin" level={2}>
            When should my assistant write a Plugin?
          </SectionHeading>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Reach for a plugin when you want to package a capability to share,
            version, or install across assistants, rather than extend only your
            own. The plugin is the distribution unit: its{" "}
            <code>package.json</code> manifest, the{" "}
            <code>@vellumai/plugin-api</code> peer dependency, and the install
            flow exist to make hooks, tools, skills, routes, and apps portable
            and discoverable.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
