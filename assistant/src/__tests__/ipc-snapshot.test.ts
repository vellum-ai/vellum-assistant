import { describe, expect, test } from "bun:test";

import type { ClientMessage, ServerMessage } from "../daemon/ipc-protocol.js";
import { serialize } from "../daemon/ipc-protocol.js";

/**
 * Snapshot tests for every IPC message type.
 * If any field is added, removed, or renamed, these tests will fail,
 * catching accidental protocol changes.
 */

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

type ClientMessageType = ClientMessage["type"];
const clientMessages: Record<ClientMessageType, ClientMessage> = {
  auth: {
    type: "auth",
    token: "abc123def456",
  },
  user_message: {
    type: "user_message",
    sessionId: "sess-001",
    content: "Hello, assistant!",
    interface: "cli",
    commandIntent: { domain: "screen_recording", action: "start" },
  },
  confirmation_response: {
    type: "confirmation_response",
    requestId: "req-001",
    decision: "allow",
    selectedPattern: "bash:npm *",
    selectedScope: "/projects/my-app",
  },
  contacts: {
    type: "contacts",
    action: "list",
    role: "guardian",
    limit: 50,
  },
  session_list: {
    type: "session_list",
  },
  session_create: {
    type: "session_create",
    title: "New session",
    correlationId: "corr-001",
    transport: {
      channelId: "vellum",
      interfaceId: "macos",
      hints: ["dashboard-capable"],
      uxBrief: "Prefer dashboard-first onboarding.",
    },
    threadType: "standard",
  },
  session_switch: {
    type: "session_switch",
    sessionId: "sess-002",
  },
  session_rename: {
    type: "session_rename",
    sessionId: "sess-002",
    title: "Renamed session",
  },
  ping: {
    type: "ping",
  },
  cancel: {
    type: "cancel",
  },
  delete_queued_message: {
    type: "delete_queued_message",
    sessionId: "sess-001",
    requestId: "req-001",
  },
  model_get: {
    type: "model_get",
  },
  model_set: {
    type: "model_set",
    model: "claude-opus-4-6",
  },
  image_gen_model_set: {
    type: "image_gen_model_set",
    model: "gemini-2.5-flash-image",
  },
  history_request: {
    type: "history_request",
    sessionId: "sess-001",
  },
  undo: {
    type: "undo",
    sessionId: "sess-001",
  },
  regenerate: {
    type: "regenerate",
    sessionId: "sess-001",
  },
  usage_request: {
    type: "usage_request",
    sessionId: "sess-001",
  },
  cu_session_create: {
    type: "cu_session_create",
    sessionId: "cu-sess-001",
    task: "Open Safari and search for weather",
    screenWidth: 1920,
    screenHeight: 1080,
  },
  cu_session_abort: {
    type: "cu_session_abort",
    sessionId: "cu-sess-001",
  },
  cu_observation: {
    type: "cu_observation",
    sessionId: "cu-sess-001",
    axTree: "<ax-tree>...</ax-tree>",
    axDiff: "+ new element",
    secondaryWindows: "Finder, Terminal",
    screenshot: "base64-screenshot-data",
    screenshotWidthPx: 1280,
    screenshotHeightPx: 720,
    screenWidthPt: 1920,
    screenHeightPt: 1080,
    coordinateOrigin: "top_left",
    captureDisplayId: 69734112,
    executionResult: "click completed",
  },
  ride_shotgun_start: {
    type: "ride_shotgun_start",
    durationSeconds: 300,
    intervalSeconds: 10,
  },
  ride_shotgun_stop: {
    type: "ride_shotgun_stop",
    watchId: "watch-001",
  },
  watch_observation: {
    type: "watch_observation",
    watchId: "watch-001",
    sessionId: "sess-001",
    ocrText: "Screen text captured during watch",
    appName: "Xcode",
    windowTitle: "Project.swift",
    bundleIdentifier: "com.apple.dt.Xcode",
    timestamp: 1700000000,
    captureIndex: 0,
    totalExpected: 10,
  },
  task_submit: {
    type: "task_submit",
    task: "Open Safari and search for weather",
    screenWidth: 1920,
    screenHeight: 1080,
    commandIntent: { domain: "screen_recording", action: "start" },
  },
  ui_surface_action: {
    type: "ui_surface_action",
    sessionId: "sess-001",
    surfaceId: "surface-001",
    actionId: "btn-ok",
    data: { selectedItem: "item-1" },
  },
  app_data_request: {
    type: "app_data_request",
    surfaceId: "surface-001",
    callId: "call-001",
    method: "query",
    appId: "app-001",
  },
  skills_list: {
    type: "skills_list",
  },
  skill_detail: {
    type: "skill_detail",
    skillId: "my-skill",
  },
  skills_enable: {
    type: "skills_enable",
    name: "my-skill",
  },
  skills_disable: {
    type: "skills_disable",
    name: "my-skill",
  },
  skills_configure: {
    type: "skills_configure",
    name: "my-skill",
    env: { API_KEY: "test-key" },
    apiKey: "sk-test",
    config: { verbose: true },
  },
  skills_install: {
    type: "skills_install",
    slug: "clawhub/my-skill",
    version: "1.0.0",
  },
  skills_uninstall: {
    type: "skills_uninstall",
    name: "my-skill",
  },
  skills_update: {
    type: "skills_update",
    name: "my-skill",
  },
  skills_check_updates: {
    type: "skills_check_updates",
  },
  skills_search: {
    type: "skills_search",
    query: "weather",
  },
  skills_inspect: {
    type: "skills_inspect",
    slug: "clawhub/my-skill",
  },
  skills_draft: {
    type: "skills_draft",
    sourceText: "Create a weather skill",
  },
  skills_create: {
    type: "skills_create",
    skillId: "weather-skill",
    name: "Weather Skill",
    description: "Fetches current weather",
    emoji: "🌤️",
    bodyMarkdown: "# Weather\n\nFetches weather data.",
    userInvocable: true,
    disableModelInvocation: false,
    overwrite: false,
  },
  suggestion_request: {
    type: "suggestion_request",
    sessionId: "sess-001",
    requestId: "req-suggest-001",
  },
  add_trust_rule: {
    type: "add_trust_rule",
    toolName: "bash",
    pattern: "git *",
    scope: "/projects/my-app",
    decision: "allow",
    allowHighRisk: true,
    executionTarget: "host",
  },
  trust_rules_list: {
    type: "trust_rules_list",
  },
  remove_trust_rule: {
    type: "remove_trust_rule",
    id: "rule-001",
  },
  update_trust_rule: {
    type: "update_trust_rule",
    id: "rule-001",
    tool: "bash",
    pattern: "git push *",
    scope: "/projects/my-app",
    decision: "allow",
    priority: 50,
  },
  schedules_list: {
    type: "schedules_list",
  },
  schedule_toggle: {
    type: "schedule_toggle",
    id: "sched-001",
    enabled: false,
  },
  schedule_remove: {
    type: "schedule_remove",
    id: "sched-001",
  },
  schedule_run_now: {
    type: "schedule_run_now",
    id: "sched-001",
  },
  reminders_list: {
    type: "reminders_list",
  },
  reminder_cancel: {
    type: "reminder_cancel",
    id: "rem-001",
  },
  bundle_app: {
    type: "bundle_app",
    appId: "app-001",
  },
  app_open_request: {
    type: "app_open_request",
    appId: "app-001",
  },
  app_delete: {
    type: "app_delete",
    appId: "app-001",
  },
  apps_list: {
    type: "apps_list",
  },
  home_base_get: {
    type: "home_base_get",
    ensureLinked: true,
  },
  shared_apps_list: {
    type: "shared_apps_list",
  },
  shared_app_delete: {
    type: "shared_app_delete",
    uuid: "abc-123-def",
  },
  fork_shared_app: {
    type: "fork_shared_app",
    uuid: "abc-123-def",
  },
  open_bundle: {
    type: "open_bundle",
    filePath: "/tmp/My_App.vellum",
  },
  sign_bundle_payload_response: {
    type: "sign_bundle_payload_response",
    requestId: "req-sign-001",
    signature: "dGVzdC1zaWduYXR1cmU=",
    keyId: "abc123",
    publicKey: "dGVzdA==",
  },
  get_signing_identity_response: {
    type: "get_signing_identity_response",
    requestId: "req-identity-001",
    keyId: "abc123",
    publicKey: "dGVzdA==",
  },
  secret_response: {
    type: "secret_response",
    requestId: "req-secret-001",
    value: "ghp_test_token_value",
    delivery: "store",
  },
  sessions_clear: {
    type: "sessions_clear",
  },
  conversation_search: {
    type: "conversation_search",
    query: "hello world",
    limit: 20,
    maxMessagesPerConversation: 3,
  },
  message_content_request: {
    type: "message_content_request",
    sessionId: "sess-001",
    messageId: "msg-001",
  },
  ipc_blob_probe: {
    type: "ipc_blob_probe",
    probeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    nonceSha256:
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  gallery_list: {
    type: "gallery_list",
  },
  gallery_install: {
    type: "gallery_install",
    galleryAppId: "gallery-focus-timer",
  },
  app_update_preview: {
    type: "app_update_preview",
    appId: "app-001",
    preview: "base64-png-data",
  },
  app_preview_request: {
    type: "app_preview_request",
    appId: "app-001",
  },
  app_history_request: {
    type: "app_history_request",
    appId: "app-001",
    limit: 25,
  },
  app_diff_request: {
    type: "app_diff_request",
    appId: "app-001",
    fromCommit: "abc123def456",
    toCommit: "789abc123def",
  },
  app_file_at_version_request: {
    type: "app_file_at_version_request",
    appId: "app-001",
    path: "index.html",
    commitHash: "abc123def456",
  },
  app_restore_request: {
    type: "app_restore_request",
    appId: "app-001",
    commitHash: "abc123def456",
  },
  share_app_cloud: {
    type: "share_app_cloud",
    appId: "app-001",
  },
  slack_webhook_config: {
    type: "slack_webhook_config",
    action: "get",
  },
  ingress_config: {
    type: "ingress_config",
    action: "get",
  },
  platform_config: {
    type: "platform_config",
    action: "get",
  },
  vercel_api_config: {
    type: "vercel_api_config",
    action: "get",
  },
  twitter_integration_config: {
    type: "twitter_integration_config",
    action: "get",
  },
  telegram_config: {
    type: "telegram_config",
    action: "get",
  },
  guardian_verification: {
    type: "guardian_verification",
    action: "create_challenge",
    channel: "telegram",
    sessionId: "sess-001",
  },
  twitter_auth_start: {
    type: "twitter_auth_start",
  },
  twitter_auth_status: {
    type: "twitter_auth_status",
  },
  link_open_request: {
    type: "link_open_request",
    url: "https://example.com",
  },
  ui_surface_undo: {
    type: "ui_surface_undo",
    sessionId: "sess-001",
    surfaceId: "surface-001",
  },
  publish_page: {
    type: "publish_page",
    html: "<html><body>Hello</body></html>",
  },
  unpublish_page: {
    type: "unpublish_page",
    deploymentId: "dpl-001",
  },
  diagnostics_export_request: {
    type: "diagnostics_export_request",
    conversationId: "conv-001",
    anchorMessageId: "msg-042",
  },
  accept_starter_bundle: {
    type: "accept_starter_bundle",
  },
  env_vars_request: {
    type: "env_vars_request",
  },
  integration_list: {
    type: "integration_list",
  },
  integration_connect: {
    type: "integration_connect",
    integrationId: "gmail",
  },
  integration_disconnect: {
    type: "integration_disconnect",
    integrationId: "gmail",
  },
  oauth_connect_start: {
    type: "oauth_connect_start",
    service: "gmail",
    requestedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  },
  work_items_list: {
    type: "work_items_list",
    status: "queued",
  },
  work_item_get: {
    type: "work_item_get",
    id: "wi-001",
  },
  work_item_update: {
    type: "work_item_update",
    id: "wi-001",
    title: "Updated title",
    status: "running",
  },
  work_item_complete: {
    type: "work_item_complete",
    id: "wi-001",
  },
  work_item_delete: {
    type: "work_item_delete",
    id: "wi-001",
  },
  work_item_run_task: {
    type: "work_item_run_task",
    id: "wi-001",
  },
  work_item_output: {
    type: "work_item_output",
    id: "wi-001",
  },
  work_item_preflight: {
    type: "work_item_preflight",
    id: "wi-001",
  },
  work_item_approve_permissions: {
    type: "work_item_approve_permissions",
    id: "wi-001",
    approvedTools: ["bash", "file_write"],
  },
  work_item_cancel: {
    type: "work_item_cancel",
    id: "wi-001",
  },
  document_save: {
    type: "document_save",
    surfaceId: "doc-001",
    conversationId: "conv-001",
    title: "My Document",
    content: "# Hello",
    wordCount: 1,
  },
  document_load: {
    type: "document_load",
    surfaceId: "doc-001",
  },
  document_list: {
    type: "document_list",
    conversationId: "conv-001",
  },
  subagent_abort: {
    type: "subagent_abort",
    subagentId: "sub-001",
  },
  subagent_status: {
    type: "subagent_status",
    subagentId: "sub-001",
  },
  subagent_message: {
    type: "subagent_message",
    subagentId: "sub-001",
    content: "Hello subagent",
  },
  subagent_detail_request: {
    type: "subagent_detail_request",
    subagentId: "sub-001",
    conversationId: "conv-001",
  },
  workspace_files_list: {
    type: "workspace_files_list",
  },
  workspace_file_read: {
    type: "workspace_file_read",
    path: "IDENTITY.md",
  },
  identity_get: {
    type: "identity_get",
  },
  tool_permission_simulate: {
    type: "tool_permission_simulate",
    toolName: "bash",
    input: { command: "rm -rf /tmp/test" },
    workingDir: "/projects/my-app",
    isInteractive: true,
    forcePromptSideEffects: false,
  },
  tool_names_list: {
    type: "tool_names_list",
  },
  dictation_request: {
    type: "dictation_request",
    transcription: "Hello world",
    context: {
      bundleIdentifier: "com.example.app",
      appName: "Example App",
      windowTitle: "Main Window",
      selectedText: "some selected text",
      cursorInTextField: true,
    },
  },
  contacts_invite: {
    type: "contacts_invite",
    action: "create",
    sourceChannel: "telegram",
    note: "Test invite",
    maxUses: 5,
    expiresInMs: 86400000,
  },
  assistant_inbox_escalation: {
    type: "assistant_inbox_escalation",
    action: "list",
    assistantId: "asst-001",
    status: "pending",
  },
  pairing_approval_response: {
    type: "pairing_approval_response",
    pairingRequestId: "pair-001",
    decision: "approve_once",
  },
  approved_devices_list: {
    type: "approved_devices_list",
  },
  approved_device_remove: {
    type: "approved_device_remove",
    hashedDeviceId: "hashed-device-001",
  },
  approved_devices_clear: {
    type: "approved_devices_clear",
  },
  notification_intent_result: {
    type: "notification_intent_result",
    deliveryId: "delivery-001",
    success: true,
  },
  conversation_seen_signal: {
    type: "conversation_seen_signal",
    conversationId: "conv-001",
    sourceChannel: "vellum",
    signalType: "macos_notification_view",
    confidence: "explicit",
    source: "notification-action",
    evidenceText: "User clicked View on notification",
    observedAt: 1700000000000,
    metadata: { notificationCategory: "NOTIFICATION_INTENT" },
  },
  recording_status: {
    type: "recording_status",
    sessionId: "rec-001",
    status: "started",
  },
  heartbeat_config: {
    type: "heartbeat_config",
    action: "get",
  },
  heartbeat_runs_list: {
    type: "heartbeat_runs_list",
  },
  heartbeat_run_now: {
    type: "heartbeat_run_now",
  },
  heartbeat_checklist_read: {
    type: "heartbeat_checklist_read",
  },
  heartbeat_checklist_write: {
    type: "heartbeat_checklist_write",
    content: "- [ ] Check email\n- [ ] Review PRs",
  },
  voice_config_update: {
    type: "voice_config_update",
    activationKey: "fn",
  },
  generate_avatar: {
    type: "generate_avatar",
    description: "a friendly purple cat with green eyes wearing a tiny hat",
  },
  guardian_actions_pending_request: {
    type: "guardian_actions_pending_request",
    conversationId: "conv-guardian-001",
  },
  guardian_action_decision: {
    type: "guardian_action_decision",
    requestId: "req-guardian-001",
    action: "approve_once",
    conversationId: "conv-guardian-001",
  },
  reorder_threads: {
    type: "reorder_threads",
    updates: [
      { sessionId: "sess-001", displayOrder: 0, isPinned: false },
      { sessionId: "sess-002", displayOrder: 1, isPinned: true },
    ],
  },
};

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

type ServerMessageType = ServerMessage["type"];
const serverMessages: Record<ServerMessageType, ServerMessage> = {
  auth_result: {
    type: "auth_result",
    success: true,
  },
  user_message_echo: {
    type: "user_message_echo",
    text: "Check the weather for me",
    sessionId: "sess-001",
  },
  assistant_text_delta: {
    type: "assistant_text_delta",
    text: "Here is some output",
    sessionId: "sess-001",
  },
  assistant_thinking_delta: {
    type: "assistant_thinking_delta",
    thinking: "Let me consider this...",
  },
  tool_use_start: {
    type: "tool_use_start",
    toolName: "bash",
    input: { command: "ls -la" },
  },
  tool_output_chunk: {
    type: "tool_output_chunk",
    chunk: "file1.ts\nfile2.ts\n",
  },
  tool_input_delta: {
    type: "tool_input_delta",
    toolName: "app_create",
    content: '{"html": "<div>Hello</div>"}',
    sessionId: "sess-001",
  },
  tool_result: {
    type: "tool_result",
    toolName: "bash",
    result: "Command completed successfully",
    isError: false,
    diff: {
      filePath: "/tmp/test.ts",
      oldContent: "const x = 1;",
      newContent: "const x = 2;",
      isNewFile: false,
    },
    status: "success",
  },
  secret_request: {
    type: "secret_request",
    requestId: "req-secret-001",
    service: "github",
    field: "token",
    label: "GitHub Personal Access Token",
    description: "Needed to push changes",
    placeholder: "ghp_xxxxxxxxxxxx",
    sessionId: "sess-001",
    purpose: "Push code changes to GitHub",
    allowedTools: ["browser_fill_credential"],
    allowedDomains: ["github.com"],
    allowOneTimeSend: false,
  },
  confirmation_request: {
    type: "confirmation_request",
    requestId: "req-002",
    toolName: "bash",
    input: { command: "rm -rf /tmp/test" },
    riskLevel: "high",
    executionTarget: "sandbox",
    allowlistOptions: [
      {
        label: "Allow rm commands",
        description: "Allow rm commands",
        pattern: "bash:rm *",
      },
    ],
    scopeOptions: [{ label: "In /tmp", scope: "/tmp" }],
    diff: {
      filePath: "/tmp/test.ts",
      oldContent: "old",
      newContent: "new",
      isNewFile: false,
    },
    sandboxed: false,
    sessionId: "sess-001",
  },
  confirmation_state_changed: {
    type: "confirmation_state_changed",
    sessionId: "sess-001",
    requestId: "req-002",
    state: "approved",
    source: "inline_nl",
    causedByRequestId: "req-003",
    decisionText: "approve",
  },
  contacts_response: {
    type: "contacts_response",
    success: true,
    contacts: [],
  },
  contacts_changed: {
    type: "contacts_changed",
  },
  assistant_activity_state: {
    type: "assistant_activity_state",
    sessionId: "sess-001",
    activityVersion: 1,
    phase: "thinking",
    anchor: "assistant_turn",
    requestId: "req-003",
    reason: "message_dequeued",
  },
  message_complete: {
    type: "message_complete",
    sessionId: "sess-001",
    attachments: [
      { filename: "chart.png", mimeType: "image/png", data: "iVBORw0K" },
    ],
  },
  message_request_complete: {
    type: "message_request_complete",
    sessionId: "sess-001",
    requestId: "req-inline-001",
    runStillActive: true,
  },
  session_info: {
    type: "session_info",
    sessionId: "sess-001",
    title: "My session",
    correlationId: "corr-001",
    threadType: "standard",
  },
  session_title_updated: {
    type: "session_title_updated",
    sessionId: "sess-001",
    title: "Plan sprint rollout",
  },
  session_list_response: {
    type: "session_list_response",
    sessions: [
      {
        id: "sess-001",
        title: "First session",
        createdAt: 1699999000,
        updatedAt: 1700000000,
        threadType: "standard",
      },
      {
        id: "sess-002",
        title: "Second session",
        createdAt: 1700000000,
        updatedAt: 1700001000,
        threadType: "standard",
        assistantAttention: {
          hasUnseenLatestAssistantMessage: true,
          latestAssistantMessageAt: 1700001000,
          lastSeenConfidence: "explicit",
          lastSeenSignalType: "macos_notification_view",
        },
      },
    ],
  },
  sessions_clear_response: {
    type: "sessions_clear_response",
    cleared: 3,
  },
  conversation_search_response: {
    type: "conversation_search_response",
    query: "hello world",
    results: [
      {
        conversationId: "conv-001",
        conversationTitle: "My Conversation",
        conversationUpdatedAt: 1700000000,
        matchingMessages: [
          {
            messageId: "msg-001",
            role: "user",
            excerpt: "…hello world, how are you?…",
            createdAt: 1699999000,
          },
        ],
      },
    ],
  },
  message_content_response: {
    type: "message_content_response",
    sessionId: "sess-001",
    messageId: "msg-001",
    text: "Full message content here",
    toolCalls: [{ name: "bash", result: "output", input: { command: "ls" } }],
  },
  error: {
    type: "error",
    message: "Something went wrong",
  },
  pong: {
    type: "pong",
  },
  daemon_status: {
    type: "daemon_status",
    httpPort: 7821,
  },
  generation_cancelled: {
    type: "generation_cancelled",
  },
  generation_handoff: {
    type: "generation_handoff",
    sessionId: "sess-001",
    requestId: "req-handoff-001",
    queuedCount: 2,
    attachments: [
      { filename: "report.pdf", mimeType: "application/pdf", data: "JVBER" },
    ],
  },
  model_info: {
    type: "model_info",
    model: "claude-opus-4-6",
    provider: "anthropic",
  },
  history_response: {
    type: "history_response",
    sessionId: "sess-history-001",
    hasMore: false,
    messages: [
      { role: "user", text: "Hello", timestamp: 1700000000 },
      {
        role: "assistant",
        text: "Hi there!",
        timestamp: 1700000001,
        attachments: [
          { filename: "result.png", mimeType: "image/png", data: "iVBORw0K" },
        ],
      },
    ],
  },
  undo_complete: {
    type: "undo_complete",
    removedCount: 2,
    sessionId: "session-abc",
  },
  usage_update: {
    type: "usage_update",
    inputTokens: 150,
    outputTokens: 50,
    totalInputTokens: 1500,
    totalOutputTokens: 500,
    estimatedCost: 0.025,
    model: "claude-opus-4-6",
  },
  usage_response: {
    type: "usage_response",
    totalInputTokens: 1500,
    totalOutputTokens: 500,
    estimatedCost: 0.025,
    model: "claude-opus-4-6",
  },
  context_compacted: {
    type: "context_compacted",
    previousEstimatedInputTokens: 220000,
    estimatedInputTokens: 108000,
    maxInputTokens: 180000,
    thresholdTokens: 144000,
    compactedMessages: 56,
    summaryCalls: 3,
    summaryInputTokens: 4200,
    summaryOutputTokens: 900,
    summaryModel: "claude-opus-4-6",
  },
  secret_detected: {
    type: "secret_detected",
    toolName: "bash",
    matches: [{ type: "api_key", redactedValue: "sk-****abcd" }],
    action: "redact",
  },
  memory_recalled: {
    type: "memory_recalled",
    provider: "openai",
    model: "text-embedding-3-small",
    lexicalHits: 12,
    semanticHits: 8,
    recencyHits: 6,
    entityHits: 3,
    relationSeedEntityCount: 2,
    relationTraversedEdgeCount: 5,
    relationNeighborEntityCount: 3,
    relationExpandedItemCount: 4,
    earlyTerminated: false,
    mergedCount: 18,
    selectedCount: 10,
    rerankApplied: false,
    injectedTokens: 480,
    latencyMs: 55,
    topCandidates: [
      {
        key: "segment:seg-1",
        type: "segment",
        kind: "fact",
        finalScore: 0.85,
        lexical: 0.9,
        semantic: 0.7,
        recency: 0.3,
      },
      {
        key: "item:item-1",
        type: "item",
        kind: "preference",
        finalScore: 0.72,
        lexical: 0.6,
        semantic: 0.8,
        recency: 0.1,
      },
    ],
  },
  memory_status: {
    type: "memory_status",
    enabled: true,
    degraded: false,
    provider: "openai",
    model: "text-embedding-3-small",
    conflictsPending: 2,
    conflictsResolved: 7,
    oldestPendingConflictAgeMs: 90_000,
    cleanupResolvedJobsPending: 1,
    cleanupSupersededJobsPending: 0,
    cleanupResolvedJobsCompleted24h: 12,
    cleanupSupersededJobsCompleted24h: 8,
  },
  cu_action: {
    type: "cu_action",
    sessionId: "cu-sess-001",
    toolName: "click",
    input: { x: 100, y: 200 },
    reasoning: "Clicking the search button",
    stepNumber: 1,
  },
  cu_complete: {
    type: "cu_complete",
    sessionId: "cu-sess-001",
    summary: "Successfully opened Safari and searched for weather",
    stepCount: 5,
  },
  cu_error: {
    type: "cu_error",
    sessionId: "cu-sess-001",
    message: "Session timed out after 30 steps",
  },
  task_routed: {
    type: "task_routed",
    sessionId: "sess-routed-001",
    interactionType: "computer_use",
  },
  ride_shotgun_error: {
    type: "ride_shotgun_error",
    watchId: "watch-shotgun-001",
    sessionId: "sess-shotgun-001",
    message: "Failed to start browser — Chrome CDP could not be launched.",
  },
  ride_shotgun_progress: {
    type: "ride_shotgun_progress",
    watchId: "watch-shotgun-001",
    message: "Observing user activity...",
  },
  ride_shotgun_result: {
    type: "ride_shotgun_result",
    sessionId: "sess-shotgun-001",
    watchId: "watch-shotgun-001",
    summary: "User was debugging a test failure",
    observationCount: 5,
  },
  ui_surface_show: {
    type: "ui_surface_show",
    sessionId: "sess-001",
    surfaceId: "surface-001",
    surfaceType: "card",
    title: "Status Update",
    data: { title: "Build Complete", body: "All tests passed." },
    actions: [{ id: "dismiss", label: "OK", style: "primary" }],
  },
  ui_surface_update: {
    type: "ui_surface_update",
    sessionId: "sess-001",
    surfaceId: "surface-001",
    data: { body: "Updated body text." },
  },
  ui_surface_dismiss: {
    type: "ui_surface_dismiss",
    sessionId: "sess-001",
    surfaceId: "surface-001",
  },
  ui_surface_complete: {
    type: "ui_surface_complete",
    sessionId: "sess-001",
    surfaceId: "surface-001",
    summary: "Confirmed",
  },
  app_data_response: {
    type: "app_data_response",
    surfaceId: "surface-001",
    callId: "call-001",
    success: true,
    result: [
      {
        id: "rec-001",
        appId: "app-001",
        data: { name: "Test" },
        createdAt: 1700000000,
        updatedAt: 1700000000,
      },
    ],
  },
  skills_list_response: {
    type: "skills_list_response",
    skills: [
      {
        id: "my-skill",
        name: "My Skill",
        description: "A test skill",
        emoji: "🔧",
        source: "bundled",
        state: "enabled",
        degraded: false,
        updateAvailable: false,
        userInvocable: true,
        provenance: { kind: "first-party", provider: "Vellum" },
      },
    ],
  },
  skills_state_changed: {
    type: "skills_state_changed",
    name: "my-skill",
    state: "enabled",
  },
  skills_operation_response: {
    type: "skills_operation_response",
    operation: "enable",
    success: true,
  },
  skill_detail_response: {
    type: "skill_detail_response",
    skillId: "my-skill",
    body: "# Skill content\n\nDo the thing.",
  },
  skills_inspect_response: {
    type: "skills_inspect_response",
    slug: "clawhub/my-skill",
    data: {
      skill: {
        slug: "clawhub/my-skill",
        displayName: "My Skill",
        summary: "A test skill",
      },
      owner: { handle: "clawhub", displayName: "ClaWHub" },
      stats: { stars: 42, installs: 1000, downloads: 5000, versions: 3 },
      createdAt: 1700000000,
      updatedAt: 1700001000,
      latestVersion: { version: "1.2.0", changelog: "Bug fixes" },
      files: [{ path: "SKILL.md", size: 1024 }],
      skillMdContent: "# My Skill\n\nDoes things.",
    },
  },
  skills_draft_response: {
    type: "skills_draft_response",
    success: true,
    draft: {
      skillId: "weather-skill",
      name: "Weather Skill",
      description: "Fetches current weather",
      emoji: "🌤️",
      bodyMarkdown: "# Weather\n\nFetches weather data.",
    },
    warnings: [],
  },
  suggestion_response: {
    type: "suggestion_response",
    requestId: "req-suggest-001",
    suggestion: "Tell me more about that",
    source: "llm",
  },
  message_queued: {
    type: "message_queued",
    sessionId: "sess-001",
    requestId: "req-queue-001",
    position: 1,
  },
  message_dequeued: {
    type: "message_dequeued",
    sessionId: "sess-001",
    requestId: "req-queue-001",
  },
  message_queued_deleted: {
    type: "message_queued_deleted",
    sessionId: "sess-001",
    requestId: "req-queue-001",
  },
  notification_intent: {
    type: "notification_intent",
    sourceEventName: "guardian.question",
    title: "⚠️ Attention needed",
    body: "Your assistant needs your input.",
    deepLinkMetadata: {
      conversationId: "conv-guardian-001",
    },
  },
  notification_thread_created: {
    type: "notification_thread_created",
    conversationId: "conv-notif-001",
    title: "Weather alert for your area",
    sourceEventName: "watcher.escalation",
  },
  heartbeat_alert: {
    type: "heartbeat_alert",
    title: "Heartbeat stalled",
    body: "No activity detected in the last 60 minutes.",
  },
  watch_started: {
    type: "watch_started",
    sessionId: "sess-001",
    watchId: "watch-001",
    durationSeconds: 300,
    intervalSeconds: 5,
  },
  watch_complete_request: {
    type: "watch_complete_request",
    sessionId: "sess-001",
    watchId: "watch-001",
  },
  trust_rules_list_response: {
    type: "trust_rules_list_response",
    rules: [
      {
        id: "rule-001",
        tool: "bash",
        pattern: "git *",
        scope: "/projects/my-app",
        decision: "allow",
        priority: 100,
        createdAt: 1700000000,
      },
    ],
  },
  schedule_thread_created: {
    type: "schedule_thread_created",
    conversationId: "conv-sched-001",
    scheduleJobId: "sched-job-001",
    title: "Daily standup reminder",
  },
  schedules_list_response: {
    type: "schedules_list_response",
    schedules: [
      {
        id: "sched-001",
        name: "Daily standup reminder",
        enabled: true,
        syntax: "cron",
        expression: "0 9 * * 1-5",
        cronExpression: "0 9 * * 1-5",
        timezone: "America/Los_Angeles",
        message: "Remind me about the standup",
        nextRunAt: 1700100000000,
        lastRunAt: 1700000000000,
        lastStatus: "ok",
        description: "Every weekday at 9:00 AM",
      },
    ],
  },
  reminders_list_response: {
    type: "reminders_list_response",
    reminders: [
      {
        id: "rem-001",
        label: "Call Sidd",
        message: "Remember to call Sidd about the project",
        fireAt: 1700100000000,
        mode: "notify",
        status: "pending",
        firedAt: null,
        createdAt: 1700000000000,
      },
    ],
  },
  bundle_app_response: {
    type: "bundle_app_response",
    bundlePath: "/tmp/My_App-abc12345.vellum",
    manifest: {
      format_version: 1,
      name: "My App",
      description: "A test app",
      created_at: "2026-01-01T00:00:00.000Z",
      created_by: "vellum-assistant/0.1.6",
      entry: "index.html",
      capabilities: [],
      version: "1.0.0",
      content_id: "a1b2c3d4e5f6a7b8",
    },
  },
  apps_list_response: {
    type: "apps_list_response",
    apps: [
      {
        id: "app-001",
        name: "My App",
        description: "A test app",
        icon: "\u{1F4F1}",
        preview: "iVBORw0KGgoAAAANSUhEUg==",
        createdAt: 1700000000,
        version: "1.0.0",
        contentId: "a1b2c3d4e5f6a7b8",
      },
    ],
  },
  home_base_get_response: {
    type: "home_base_get_response",
    homeBase: {
      appId: "home-base-001",
      source: "prebuilt_seed",
      starterTasks: [
        "Change the look and feel",
        "Research something for me about X",
        "Turn it into a webpage or interactive UI",
      ],
      onboardingTasks: [
        "Make it mine",
        "Enable voice mode",
        "Enable computer control",
        "Try ambient mode",
      ],
      preview: {
        title: "Home Base",
        subtitle: "Dashboard",
        description: "Prebuilt onboarding + starter task canvas",
        icon: "\u{1F3E0}",
        metrics: [
          { label: "Starter tasks", value: "3" },
          { label: "Onboarding tasks", value: "4" },
        ],
      },
    },
  },
  shared_apps_list_response: {
    type: "shared_apps_list_response",
    apps: [
      {
        uuid: "abc-123-def",
        name: "Shared App",
        description: "A shared app",
        icon: "\u{1F4F1}",
        preview: "iVBORw0KGgoAAAANSUhEUg==",
        entry: "index.html",
        trustTier: "signed",
        signerDisplayName: "Test User",
        bundleSizeBytes: 4096,
        installedAt: "2026-01-15T00:00:00Z",
        version: "1.2.0",
        contentId: "abcdef0123456789",
        updateAvailable: true,
      },
    ],
  },
  app_delete_response: {
    type: "app_delete_response",
    success: true,
  },
  shared_app_delete_response: {
    type: "shared_app_delete_response",
    success: true,
  },
  fork_shared_app_response: {
    type: "fork_shared_app_response",
    success: true,
    appId: "new-app-id",
    name: "My App (Fork)",
  },
  open_bundle_response: {
    type: "open_bundle_response",
    manifest: {
      format_version: 1,
      name: "My App",
      description: "A test app",
      created_at: "2026-01-01T00:00:00.000Z",
      created_by: "vellum-assistant/0.1.6",
      entry: "index.html",
      capabilities: [],
    },
    scanResult: {
      passed: true,
      blocked: [],
      warnings: ["Use of fetch() detected"],
    },
    signatureResult: {
      trustTier: "signed",
      signerKeyId: "key-001",
      signerDisplayName: "Test Signer",
      signerAccount: "test@example.com",
    },
    bundleSizeBytes: 4096,
  },
  sign_bundle_payload: {
    type: "sign_bundle_payload",
    requestId: "req-sign-001",
    payload: '{"content_hashes":{},"manifest":{}}',
  },
  get_signing_identity: {
    type: "get_signing_identity",
    requestId: "req-identity-001",
  },
  session_error: {
    type: "session_error",
    sessionId: "sess-001",
    code: "PROVIDER_NETWORK",
    userMessage: "Unable to reach the AI provider. Please try again.",
    retryable: true,
    debugDetails: "ETIMEDOUT after 30000ms",
  },
  trace_event: {
    type: "trace_event",
    eventId: "evt-001",
    sessionId: "sess-001",
    requestId: "req-001",
    timestampMs: 1700000000000,
    sequence: 1,
    kind: "tool_started",
    status: "info",
    summary: "Running bash: ls -la",
    attributes: {
      toolName: "bash",
      command: "ls -la",
      riskLevel: "low",
      sandboxed: true,
    },
  },
  ipc_blob_probe_result: {
    type: "ipc_blob_probe_result",
    probeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    ok: true,
    observedNonceSha256:
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  gallery_list_response: {
    type: "gallery_list_response",
    gallery: {
      version: 1,
      updatedAt: "2026-02-15T00:00:00Z",
      categories: [
        { id: "productivity", name: "Productivity", icon: "\u{1F4CB}" },
      ],
      apps: [],
    },
  },
  gallery_install_response: {
    type: "gallery_install_response",
    success: true,
    appId: "app-new-001",
    name: "Focus Timer",
  },
  share_app_cloud_response: {
    type: "share_app_cloud_response",
    success: true,
    shareToken: "abc123def456",
    shareUrl: "http://localhost:7821/v1/apps/shared/abc123def456",
  },
  slack_webhook_config_response: {
    type: "slack_webhook_config_response",
    webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
    success: true,
  },
  ingress_config_response: {
    type: "ingress_config_response",
    enabled: true,
    publicBaseUrl: "https://example.com",
    localGatewayTarget: "http://127.0.0.1:7830",
    success: true,
  },
  platform_config_response: {
    type: "platform_config_response",
    baseUrl: "https://platform.vellum.ai",
    success: true,
  },
  vercel_api_config_response: {
    type: "vercel_api_config_response",
    hasToken: true,
    success: true,
  },
  twitter_integration_config_response: {
    type: "twitter_integration_config_response",
    success: true,
    mode: "local_byo",
    managedAvailable: false,
    localClientConfigured: true,
    connected: false,
  },
  telegram_config_response: {
    type: "telegram_config_response",
    success: true,
    hasBotToken: true,
    botUsername: "my_test_bot",
    connected: true,
    hasWebhookSecret: true,
  },
  guardian_verification_response: {
    type: "guardian_verification_response",
    success: true,
    secret: "verify-secret-123",
    instruction: "Send this code to the Telegram bot",
  },
  twitter_auth_result: {
    type: "twitter_auth_result",
    success: true,
    accountInfo: "@vellum_test",
  },
  twitter_auth_status_response: {
    type: "twitter_auth_status_response",
    connected: true,
    accountInfo: "@vellum_test",
    mode: "local_byo",
  },
  open_url: {
    type: "open_url",
    url: "https://example.com",
    title: "Example",
  },
  app_update_preview_response: {
    type: "app_update_preview_response",
    success: true,
    appId: "app-001",
  },
  app_preview_response: {
    type: "app_preview_response",
    appId: "app-001",
    preview: "base64-png-data",
  },
  app_history_response: {
    type: "app_history_response",
    appId: "app-001",
    versions: [
      {
        commitHash: "abc123def456",
        message: "Initial app commit",
        timestamp: 1700000000,
      },
      {
        commitHash: "789abc123def",
        message: "Update landing page",
        timestamp: 1700001000,
      },
    ],
  },
  app_diff_response: {
    type: "app_diff_response",
    appId: "app-001",
    diff: "diff --git a/index.html b/index.html",
  },
  app_file_at_version_response: {
    type: "app_file_at_version_response",
    appId: "app-001",
    path: "index.html",
    content: "<html><body>Hello</body></html>",
  },
  app_restore_response: {
    type: "app_restore_response",
    success: true,
  },
  ui_surface_undo_result: {
    type: "ui_surface_undo_result",
    sessionId: "sess-001",
    surfaceId: "surface-001",
    success: true,
    remainingUndos: 3,
  },
  publish_page_response: {
    type: "publish_page_response",
    success: true,
    publicUrl: "https://example.vercel.app",
    deploymentId: "dpl-001",
  },
  unpublish_page_response: {
    type: "unpublish_page_response",
    success: true,
  },
  app_files_changed: {
    type: "app_files_changed",
    appId: "app-001",
  },
  diagnostics_export_response: {
    type: "diagnostics_export_response",
    success: true,
    filePath: "/tmp/diagnostics-conv-001.zip",
  },
  accept_starter_bundle_response: {
    type: "accept_starter_bundle_response",
    accepted: true,
    rulesAdded: 5,
    alreadyAccepted: false,
  },
  env_vars_response: {
    type: "env_vars_response",
    vars: { HOME: "/Users/test", PATH: "/usr/bin" },
  },
  integration_list_response: {
    type: "integration_list_response",
    integrations: [{ id: "gmail", connected: false }],
  },
  integration_connect_result: {
    type: "integration_connect_result",
    integrationId: "gmail",
    success: true,
  },
  oauth_connect_result: {
    type: "oauth_connect_result",
    success: true,
    grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    accountInfo: "user@example.com",
  },
  document_editor_show: {
    type: "document_editor_show",
    sessionId: "sess-001",
    surfaceId: "doc-001",
    title: "My Document",
    initialContent: "# Hello World",
  },
  document_editor_update: {
    type: "document_editor_update",
    sessionId: "sess-001",
    surfaceId: "doc-001",
    markdown: "# Updated Content",
    mode: "replace",
  },
  document_save_response: {
    type: "document_save_response",
    surfaceId: "doc-001",
    success: true,
  },
  document_load_response: {
    type: "document_load_response",
    surfaceId: "doc-001",
    conversationId: "conv-001",
    title: "My Document",
    content: "# Hello",
    wordCount: 1,
    createdAt: 1700000000,
    updatedAt: 1700001000,
    success: true,
  },
  document_list_response: {
    type: "document_list_response",
    documents: [
      {
        surfaceId: "doc-001",
        conversationId: "conv-001",
        title: "My Document",
        wordCount: 100,
        createdAt: 1700000000,
        updatedAt: 1700001000,
      },
    ],
  },
  work_items_list_response: {
    type: "work_items_list_response",
    items: [
      {
        id: "wi-001",
        taskId: "task-001",
        title: "Process report",
        notes: null,
        status: "queued",
        priorityTier: 1,
        sortIndex: null,
        lastRunId: null,
        lastRunConversationId: null,
        lastRunStatus: null,
        sourceType: null,
        sourceId: null,
        createdAt: 1700000000,
        updatedAt: 1700000000,
      },
    ],
  },
  work_item_get_response: {
    type: "work_item_get_response",
    item: {
      id: "wi-001",
      taskId: "task-001",
      title: "Process report",
      notes: null,
      status: "queued",
      priorityTier: 1,
      sortIndex: null,
      lastRunId: null,
      lastRunConversationId: null,
      lastRunStatus: null,
      sourceType: null,
      sourceId: null,
      createdAt: 1700000000,
      updatedAt: 1700000000,
    },
  },
  work_item_update_response: {
    type: "work_item_update_response",
    item: {
      id: "wi-001",
      taskId: "task-001",
      title: "Updated title",
      notes: null,
      status: "running",
      priorityTier: 1,
      sortIndex: null,
      lastRunId: null,
      lastRunConversationId: null,
      lastRunStatus: null,
      sourceType: null,
      sourceId: null,
      createdAt: 1700000000,
      updatedAt: 1700001000,
    },
  },
  work_item_delete_response: {
    type: "work_item_delete_response",
    id: "wi-001",
    success: true,
  },
  work_item_run_task_response: {
    type: "work_item_run_task_response",
    id: "wi-001",
    lastRunId: "run-001",
    success: true,
  },
  work_item_output_response: {
    type: "work_item_output_response",
    id: "wi-001",
    success: true,
    output: {
      title: "Process report",
      status: "completed",
      runId: "run-001",
      conversationId: "conv-001",
      completedAt: 1700002000,
      summary: "Report processed successfully.",
      highlights: ["- Key finding 1", "- Key finding 2"],
    },
  },
  work_item_preflight_response: {
    type: "work_item_preflight_response",
    id: "wi-001",
    success: true,
    permissions: [
      {
        tool: "bash",
        description: "Run shell commands",
        riskLevel: "medium",
        currentDecision: "prompt",
      },
    ],
  },
  work_item_approve_permissions_response: {
    type: "work_item_approve_permissions_response",
    id: "wi-001",
    success: true,
  },
  work_item_cancel_response: {
    type: "work_item_cancel_response",
    id: "wi-001",
    success: true,
  },
  work_item_status_changed: {
    type: "work_item_status_changed",
    item: {
      id: "wi-001",
      taskId: "task-001",
      title: "Process report",
      status: "awaiting_review",
      lastRunId: "run-001",
      lastRunConversationId: "conv-001",
      lastRunStatus: "completed",
      updatedAt: 1700001000,
    },
  },
  tasks_changed: {
    type: "tasks_changed",
  },
  task_run_thread_created: {
    type: "task_run_thread_created",
    conversationId: "conv-task-run-001",
    workItemId: "wi-001",
    title: "Process report",
  },
  subagent_spawned: {
    type: "subagent_spawned",
    subagentId: "sub-001",
    parentSessionId: "sess-001",
    label: "Research Agent",
    objective: "Find relevant documentation",
  },
  subagent_status_changed: {
    type: "subagent_status_changed",
    subagentId: "sub-001",
    status: "completed",
  },
  subagent_event: {
    type: "subagent_event",
    subagentId: "sub-001",
    event: {
      type: "assistant_text_delta",
      text: "Searching for docs...",
      sessionId: "sub-sess-001",
    },
  },
  subagent_detail_response: {
    type: "subagent_detail_response",
    subagentId: "sub-001",
    objective: "Search for documentation",
    events: [
      {
        type: "tool_use",
        content: "Reading file...",
        toolName: "read_file",
        isError: false,
      },
    ],
  },
  workspace_files_list_response: {
    type: "workspace_files_list_response",
    files: [{ path: "IDENTITY.md", name: "IDENTITY.md", exists: true }],
  },
  workspace_file_read_response: {
    type: "workspace_file_read_response",
    path: "IDENTITY.md",
    content: "# My Identity",
  },
  identity_get_response: {
    type: "identity_get_response",
    found: true,
    name: "Vex",
    role: "AI assistant",
    personality: "Friendly",
    emoji: "✨",
    home: "~/workspace",
  },
  tool_permission_simulate_response: {
    type: "tool_permission_simulate_response",
    success: true,
    decision: "prompt",
    riskLevel: "high",
    reason: "No matching trust rule; tool requires approval",
    promptPayload: {
      allowlistOptions: [
        {
          label: "Allow rm commands",
          description: "Allow rm commands",
          pattern: "bash:rm *",
        },
      ],
      scopeOptions: [
        { label: "In /projects/my-app", scope: "/projects/my-app" },
      ],
      persistentDecisionsAllowed: true,
    },
    executionTarget: "host",
    matchedRuleId: undefined,
  },
  tool_names_list_response: {
    type: "tool_names_list_response",
    names: ["bash", "file_read", "file_write"],
  },
  dictation_response: {
    type: "dictation_response",
    text: "Hello world",
    mode: "dictation",
    actionPlan: undefined,
  },
  contacts_invite_response: {
    type: "contacts_invite_response",
    success: true,
    invite: {
      id: "inv-001",
      sourceChannel: "telegram",
      token: "tok-abc123",
      tokenHash: "hash-abc123",
      maxUses: 5,
      useCount: 0,
      expiresAt: 1700100000000,
      status: "active",
      note: "Test invite",
      createdAt: 1700000000,
    },
  },
  assistant_inbox_escalation_response: {
    type: "assistant_inbox_escalation_response",
    success: true,
    escalations: [
      {
        id: "esc-001",
        runId: "run-001",
        conversationId: "conv-001",
        channel: "telegram",
        requesterExternalUserId: "user-123",
        requesterChatId: "chat-456",
        status: "pending",
        requestSummary: "Access request from new user",
        createdAt: 1700000000,
      },
    ],
  },
  pairing_approval_request: {
    type: "pairing_approval_request",
    pairingRequestId: "pair-001",
    deviceId: "device-001",
    deviceName: "iPhone 15",
  },
  approved_devices_list_response: {
    type: "approved_devices_list_response",
    devices: [
      {
        hashedDeviceId: "hashed-device-001",
        deviceName: "iPhone 15",
        lastPairedAt: 1700000000000,
      },
    ],
  },
  approved_device_remove_response: {
    type: "approved_device_remove_response",
    success: true,
  },
  recording_pause: {
    type: "recording_pause",
    recordingId: "rec-001",
  },
  recording_resume: {
    type: "recording_resume",
    recordingId: "rec-001",
  },
  recording_start: {
    type: "recording_start",
    recordingId: "rec-001",
  },
  recording_stop: {
    type: "recording_stop",
    recordingId: "rec-001",
  },
  heartbeat_config_response: {
    type: "heartbeat_config_response",
    enabled: true,
    intervalMs: 3600000,
    activeHoursStart: 9,
    activeHoursEnd: 17,
    nextRunAt: 1700003600000,
    success: true,
  },
  heartbeat_runs_list_response: {
    type: "heartbeat_runs_list_response",
    runs: [
      {
        id: "hb-run-001",
        title: "Morning heartbeat",
        createdAt: 1700000000000,
        result: "All systems nominal",
      },
    ],
  },
  heartbeat_run_now_response: {
    type: "heartbeat_run_now_response",
    success: true,
  },
  heartbeat_checklist_response: {
    type: "heartbeat_checklist_response",
    content: "- [ ] Check email\n- [ ] Review PRs",
    isDefault: false,
  },
  heartbeat_checklist_write_response: {
    type: "heartbeat_checklist_write_response",
    success: true,
  },
  navigate_settings: {
    type: "navigate_settings",
    tab: "general",
  },
  client_settings_update: {
    type: "client_settings_update",
    key: "activationKey",
    value: "fn",
  },
  identity_changed: {
    type: "identity_changed",
    name: "Vellum",
    role: "assistant",
    personality: "friendly",
    emoji: "",
    home: "",
  },
  avatar_updated: {
    type: "avatar_updated",
    avatarPath: "/Users/test/.vellum/workspace/data/avatar/custom-avatar.png",
  },
  generate_avatar_response: {
    type: "generate_avatar_response",
    success: true,
    error: undefined,
  },
  guardian_actions_pending_response: {
    type: "guardian_actions_pending_response",
    conversationId: "conv-guardian-001",
    prompts: [
      {
        requestId: "req-guardian-001",
        requestCode: "REQ-GU",
        state: "pending",
        questionText: "Approve tool: bash",
        toolName: "bash",
        actions: [
          { action: "approve_once", label: "Approve once" },
          { action: "reject", label: "Reject" },
        ],
        expiresAt: 1700100000000,
        conversationId: "conv-guardian-001",
        callSessionId: null,
      },
    ],
  },
  guardian_action_decision_response: {
    type: "guardian_action_decision_response",
    applied: true,
    reason: undefined,
    requestId: "req-guardian-001",
    userText: undefined,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IPC message snapshots", () => {
  describe("ClientMessage types", () => {
    for (const [name, msg] of Object.entries(clientMessages)) {
      test(`${name} serializes to expected JSON`, () => {
        const serialized = serialize(msg);
        // serialize appends a newline; strip it for the snapshot comparison
        const json = JSON.parse(serialized);
        expect(json).toMatchSnapshot();
      });
    }
  });

  describe("ServerMessage types", () => {
    for (const [name, msg] of Object.entries(serverMessages)) {
      test(`${name} serializes to expected JSON`, () => {
        const serialized = serialize(msg);
        const json = JSON.parse(serialized);
        expect(json).toMatchSnapshot();
      });
    }
  });

  test("round-trip: serialize then parse matches original for all ClientMessages", () => {
    for (const msg of Object.values(clientMessages)) {
      const serialized = serialize(msg);
      const parsed = JSON.parse(serialized.trimEnd());
      expect(parsed).toEqual(msg);
    }
  });

  test("round-trip: serialize then parse matches original for all ServerMessages", () => {
    for (const msg of Object.values(serverMessages)) {
      const serialized = serialize(msg);
      const parsed = JSON.parse(serialized.trimEnd());
      expect(parsed).toEqual(msg);
    }
  });

  // -----------------------------------------------------------------------
  // Baseline characterization — freeze credential IPC contract before hardening
  // -----------------------------------------------------------------------
  describe("credential IPC baselines", () => {
    test("secret_request includes policy context fields", () => {
      // After PR 10: secret_request now includes policy context fields
      // for purpose, allowedTools, allowedDomains, and allowOneTimeSend.
      const req = serverMessages.secret_request;
      const keys = Object.keys(req).sort();
      expect(keys).toEqual([
        "allowOneTimeSend",
        "allowedDomains",
        "allowedTools",
        "description",
        "field",
        "label",
        "placeholder",
        "purpose",
        "requestId",
        "service",
        "sessionId",
        "type",
      ]);
    });

    test("secret_response has no audit or provenance fields", () => {
      // The current secret_response includes: type, requestId, value?, delivery?.
      // It has NO provenance, audit-id, or encrypted-handle fields.
      const resp = clientMessages.secret_response;
      const keys = Object.keys(resp).sort();
      expect(keys).toEqual(["delivery", "requestId", "type", "value"]);
    });

    test("secret_request round-trips with all optional fields populated", () => {
      const req = serverMessages.secret_request;
      const serialized = serialize(req);
      const parsed = JSON.parse(serialized.trimEnd());
      expect(parsed).toEqual(req);
      // Verify the optional fields are present in the fixture
      expect(parsed.description).toBeDefined();
      expect(parsed.placeholder).toBeDefined();
      expect(parsed.sessionId).toBeDefined();
    });

    test("secret_response round-trips with value present", () => {
      const resp = clientMessages.secret_response;
      const serialized = serialize(resp);
      const parsed = JSON.parse(serialized.trimEnd());
      expect(parsed).toEqual(resp);
      expect(parsed.value).toBe("ghp_test_token_value");
    });

    test("secret_response round-trips with value absent (user cancelled)", () => {
      const cancelled: typeof clientMessages.secret_response = {
        type: "secret_response",
        requestId: "req-cancel-001",
        delivery: "store",
        // value intentionally omitted — user cancelled the prompt
      };
      const serialized = serialize(cancelled);
      const parsed = JSON.parse(serialized.trimEnd());
      expect(parsed.type).toBe("secret_response");
      expect(parsed.requestId).toBe("req-cancel-001");
      expect(parsed.value).toBeUndefined();
    });
  });

  // Baseline assertions for error-related message contracts.
  // These document the current shape before error handling modernization.
  describe("error message baselines", () => {
    test("error message has exactly type and message fields", () => {
      const keys = Object.keys(serverMessages.error).sort();
      expect(keys).toEqual(["message", "type"]);
    });

    test("cu_error message has exactly type, sessionId, and message fields", () => {
      const keys = Object.keys(serverMessages.cu_error).sort();
      expect(keys).toEqual(["message", "sessionId", "type"]);
    });

    test("tool_result isError field is optional boolean", () => {
      const withError = { ...serverMessages.tool_result, isError: true };
      const withoutError = { ...serverMessages.tool_result };
      delete (withoutError as Record<string, unknown>).isError;

      // Both shapes must round-trip cleanly
      expect(JSON.parse(serialize(withError).trimEnd()).isError).toBe(true);
      const parsed = JSON.parse(serialize(withoutError).trimEnd());
      expect(parsed.isError).toBeUndefined();
    });

    test("generation_cancelled has type field and optional sessionId", () => {
      const cancelled = serverMessages.generation_cancelled;
      expect(cancelled.type).toBe("generation_cancelled");
    });

    test("message_complete has type field and optional sessionId", () => {
      const complete = serverMessages.message_complete;
      expect(complete.type).toBe("message_complete");
    });

    test("message_request_complete has sessionId and requestId fields", () => {
      const complete = serverMessages.message_request_complete;
      expect(complete.type).toBe("message_request_complete");
      expect((complete as unknown as { sessionId: string }).sessionId).toBe(
        "sess-001",
      );
      expect((complete as unknown as { requestId: string }).requestId).toBe(
        "req-inline-001",
      );
    });
  });

  // Baseline: session contract includes threadType metadata
  describe("thread type baselines", () => {
    test("session_create request includes threadType field", () => {
      const req = clientMessages.session_create;
      expect("threadType" in req).toBe(true);
      expect((req as unknown as Record<string, unknown>).threadType).toBe(
        "standard",
      );
    });

    test("session_info response includes threadType field", () => {
      const info = serverMessages.session_info;
      expect("threadType" in info).toBe(true);
      expect((info as unknown as Record<string, unknown>).threadType).toBe(
        "standard",
      );
    });

    test("session_list_response sessions include threadType field", () => {
      const list = serverMessages.session_list_response as unknown as {
        sessions: Array<Record<string, unknown>>;
      };
      for (const s of list.sessions) {
        expect("threadType" in s).toBe(true);
        expect(s.threadType).toBe("standard");
      }
    });
  });
});
