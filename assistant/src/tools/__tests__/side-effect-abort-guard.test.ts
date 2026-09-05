import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import { createAbortReason } from "../../util/abort-reasons.js";
import { explicitTools } from "../tool-manifest.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Side-effecting tools must observe the turn's abort signal.
 *
 * When a user cancels mid-turn the agent loop abandons the in-flight batch and
 * tells the model the calls were cancelled. A tool that keeps going past that
 * point lands work the model has been told never happened, so every tool that
 * writes, sends, spawns, or pays must refuse to act on an already-aborted
 * signal. The lists below are deliberately explicit: a new side-effecting tool
 * has to be added here, and adding it fails until the tool honours the signal.
 *
 * Read-only tools are out of scope, and so are the teardown calls
 * (`app_control_stop`, `computer_use_done`, `ui_dismiss`, `acp_abort`,
 * `subagent_abort`, `call_end`) whose whole purpose is to stop something:
 * refusing those on a cancelled turn would strand the session they close.
 */

const ABORT_REASON = createAbortReason(
  "user_cancel",
  "side-effect-abort-guard.test",
);

const BUNDLED_SKILLS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../config/bundled-skills",
);

interface GuardedTool {
  /** Tool name as the model sees it. */
  name: string;
  /** Input that reaches the tool's side-effecting path. */
  input: Record<string, unknown>;
  /** Context fields the path to the guard reads. */
  context?: Partial<ToolContext>;
}

function abortedContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const controller = new AbortController();
  controller.abort(ABORT_REASON);
  return {
    conversationId: "conv-abort-guard",
    workingDir: "/tmp/abort-guard",
    signal: controller.signal,
    ...overrides,
  } as ToolContext;
}

/** Absolute path of the executor a bundled skill declares for one of its tools. */
function resolveSkillExecutor(toolName: string): string {
  const manifests = [
    ...new Bun.Glob("*/TOOLS.json").scanSync({ cwd: BUNDLED_SKILLS_DIR }),
  ];
  for (const relative of manifests) {
    const manifestPath = join(BUNDLED_SKILLS_DIR, relative);
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      tools?: Array<{ name?: string; executor?: string }>;
    };
    for (const tool of parsed.tools ?? []) {
      if (tool.name === toolName && typeof tool.executor === "string") {
        return join(dirname(manifestPath), tool.executor);
      }
    }
  }
  throw new Error(`No bundled skill declares a tool named "${toolName}"`);
}

async function invokeSkillTool(
  guarded: GuardedTool,
): Promise<ToolExecutionResult> {
  const module = (await import(resolveSkillExecutor(guarded.name))) as {
    run: (
      input: Record<string, unknown>,
      context: ToolContext,
    ) => Promise<ToolExecutionResult> | ToolExecutionResult;
  };
  return module.run(guarded.input, abortedContext(guarded.context));
}

async function invokeRegisteredTool(
  guarded: GuardedTool,
): Promise<ToolExecutionResult> {
  const tool = explicitTools.find(
    (candidate) => candidate.name === guarded.name,
  );
  if (!tool?.execute) {
    throw new Error(`No explicitly registered tool named "${guarded.name}"`);
  }
  return tool.execute(guarded.input, abortedContext(guarded.context));
}

/**
 * Assert the call rejects with the signal's own reason. A tool that returns a
 * validation error, a "not found", or a success instead has decided to act on
 * a turn the user already cancelled, or has spent work getting there.
 */
async function expectRefusal(
  invoke: () => Promise<ToolExecutionResult>,
): Promise<void> {
  await expect(Promise.resolve().then(invoke)).rejects.toBe(ABORT_REASON);
}

/** The trust class the memory and schedule tools require before they act. */
const GUARDIAN: Partial<ToolContext> = { trustClass: "guardian" };

/** A proxied host actuation: a keypress, a click, a drag, an app launch. */
function proxied(name: string): GuardedTool {
  return {
    name,
    input: {},
    context: {
      proxyToolResolver: async () => ({
        content: "the proxy must not be reached",
        isError: true,
      }),
    },
  };
}

const SKILL_TOOLS: GuardedTool[] = [
  { name: "acp_spawn", input: { agent: "claude", task: "do a thing" } },
  {
    name: "acp_steer",
    input: { acp_session_id: "acp-1", instruction: "change course" },
  },

  { name: "app_create", input: { name: "App", description: "An app" } },
  { name: "app_update", input: { app_id: "app-1", source_files: [] } },
  { name: "app_delete", input: { app_id: "app-1" } },
  { name: "app_refresh", input: { app_id: "app-1" } },
  { name: "app_generate_icon", input: { app_id: "app-1" } },
  {
    name: "app_open",
    input: { app_id: "app-1" },
    context: proxied("app_open").context,
  },

  proxied("app_control_start"),
  proxied("app_control_press"),
  proxied("app_control_combo"),
  proxied("app_control_sequence"),
  proxied("app_control_type"),
  proxied("app_control_click"),
  proxied("app_control_drag"),

  proxied("computer_use_click"),
  proxied("computer_use_type_text"),
  proxied("computer_use_key"),
  proxied("computer_use_scroll"),
  proxied("computer_use_drag"),
  proxied("computer_use_open_app"),
  proxied("computer_use_run_applescript"),
  proxied("computer_use_respond"),

  { name: "contact_merge", input: { keep_id: "c-1", merge_id: "c-2" } },

  { name: "conversation_group_create", input: { name: "Group" } },
  {
    name: "conversation_move_to_group",
    input: { group: "Group", conversation_id: "conv-1" },
  },

  { name: "document_create", input: { title: "Doc" } },
  { name: "document_update", input: { surface_id: "doc-1", content: "text" } },
  { name: "document_delete", input: { surface_id: "doc-1" } },
  {
    name: "document_replace_text",
    input: { surface_id: "doc-1", find: "a", replace: "b" },
  },
  {
    name: "comment_resolve",
    input: { surface_id: "doc-1", comment_id: "cm-1" },
  },
  {
    name: "comment_reply",
    input: { surface_id: "doc-1", comment_id: "cm-1", content: "reply" },
  },

  {
    name: "followup_create",
    input: { channel: "slack", conversation_id: "c" },
  },
  { name: "followup_resolve", input: { id: "f-1" } },

  { name: "media_generate_image", input: { prompt: "a cat" } },

  { name: "ingest_media", input: { file_path: "clip.mp4" } },
  { name: "extract_keyframes", input: { asset_id: "asset-1" } },
  {
    name: "analyze_keyframes",
    input: {
      asset_id: "asset-1",
      system_prompt: "describe",
      output_schema: { type: "object" },
    },
  },
  { name: "query_media", input: { asset_id: "asset-1", query: "what?" } },
  {
    name: "generate_clip",
    input: { asset_id: "asset-1", start_time: 0, end_time: 1 },
  },

  {
    name: "messaging_send",
    input: { conversation_id: "m-1", text: "hi", confidence: "high" },
  },
  { name: "messaging_mark_read", input: { conversation_id: "m-1" } },
  { name: "messaging_analyze_style", input: {} },
  {
    name: "messaging_draft",
    input: {
      action: "create",
      platform: "gmail",
      conversation_id: "m-1",
      text: "hi",
    },
  },
  {
    name: "messaging_archive_by_sender",
    input: { query: "from:sender", confidence: "high" },
    context: { triggeredBySurfaceAction: true },
  },

  {
    name: "call_start",
    input: { phone_number: "+15550100", task: "confirm the booking" },
  },

  { name: "playbook_create", input: { trigger: "t", action: "a" } },
  { name: "playbook_update", input: { playbook_id: "pb-1", action: "a" } },
  { name: "playbook_delete", input: { playbook_id: "pb-1" } },

  {
    name: "schedule_create",
    input: {
      name: "Nightly",
      description: "Runs nightly",
      syntax: "cron",
      expression: "0 3 * * *",
      message: "run",
    },
    context: GUARDIAN,
  },
  {
    name: "schedule_update",
    input: { job_id: "job-1", name: "Renamed" },
    context: GUARDIAN,
  },
  { name: "schedule_delete", input: { job_id: "job-1" } },

  {
    name: "sequence_create",
    input: {
      name: "Seq",
      channel: "email",
      steps: [{ subject: "Hello", body_prompt: "Say hello" }],
    },
  },
  { name: "sequence_update", input: { id: "seq-1", name: "Renamed" } },
  { name: "sequence_delete", input: { id: "seq-1" } },
  {
    name: "sequence_enroll",
    input: { sequence_id: "seq-1", emails: ["user@example.com"] },
  },
  {
    name: "sequence_import",
    input: {
      file_path: "contacts.csv",
      sequence_id: "seq-1",
      auto_enroll: true,
    },
  },

  {
    name: "voice_config_update",
    input: { setting: "voice", value: "alloy" },
  },
  {
    name: "open_system_settings",
    input: { pane: "microphone", platform: "macos" },
  },
  { name: "navigate_settings_tab", input: { tab: "General" } },

  {
    name: "scaffold_managed_skill",
    input: {
      skill_id: "guard-skill",
      name: "Guard Skill",
      description: "A skill",
      body_markdown: "# Guard Skill",
      activation_hints: ["guard"],
    },
  },
  { name: "delete_managed_skill", input: { skill_id: "guard-skill" } },
  { name: "find_similar_skills", input: { goal: "do a thing" } },

  {
    name: "subagent_spawn",
    input: { label: "worker", objective: "do a thing" },
  },
  {
    name: "subagent_message",
    input: { subagent_id: "sub-1", content: "carry on" },
  },

  { name: "run_workflow", input: { script: "export default () => {};" } },
  { name: "manage_workflows", input: { action: "resume", run_id: "run-1" } },

  { name: "transcribe_media", input: { file_path: "clip.m4a" } },
];

const REGISTERED_TOOLS: GuardedTool[] = [
  { name: "file_write", input: { path: "guard.txt", content: "text" } },
  {
    name: "file_edit",
    input: { path: "guard.txt", old_string: "a", new_string: "b" },
  },
  { name: "notify_parent", input: { message: "an update" } },
  { name: "react_to_message", input: { emoji: "eyes" } },
  { name: "ui_show", input: { surface_type: "card", data: { title: "T" } } },
  { name: "ui_update", input: { surface_id: "s-1", data: { title: "T" } } },
  { name: "remember", input: { content: "a fact" }, context: GUARDIAN },
  {
    name: "delete_memory_page",
    input: { slug: "a-page" },
    context: GUARDIAN,
  },
];

describe("side-effecting skill tools refuse an aborted turn", () => {
  for (const guarded of SKILL_TOOLS) {
    test(guarded.name, async () => {
      await expectRefusal(() => invokeSkillTool(guarded));
    });
  }
});

describe("side-effecting registered tools refuse an aborted turn", () => {
  for (const guarded of REGISTERED_TOOLS) {
    test(guarded.name, async () => {
      await expectRefusal(() => invokeRegisteredTool(guarded));
    });
  }
});
