/**
 * Tool definitions and executor setup extracted from Session constructor.
 *
 * The Session constructor delegates tool definition building and tool
 * executor callback creation to the helper functions exported here,
 * keeping the constructor body focused on wiring.
 */

import type { Message, ToolDefinition } from '../providers/types.js';
import type { ToolExecutionResult, ToolLifecycleEventHandler } from '../tools/types.js';
import type { ServerMessage, UiSurfaceShow } from './ipc-protocol.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { PermissionPrompter } from '../permissions/prompter.js';
import type { SecretPrompter } from '../permissions/secret-prompter.js';
import { addRule, findHighestPriorityRule } from '../permissions/trust-store.js';
import { generateAllowlistOptions, generateScopeOptions, normalizeWebFetchUrl } from '../permissions/checker.js';
import { getAllToolDefinitions } from '../tools/registry.js';
import { allUiSurfaceTools } from '../tools/ui-surface/definitions.js';
import { coreAppProxyTools } from '../tools/apps/definitions.js';
import { requestComputerControlTool } from '../tools/computer-use/request-computer-control.js';
import {
  refreshSurfacesForApp,
  surfaceProxyResolver,
} from './session-surfaces.js';
import type { SurfaceSessionContext } from './session-surfaces.js';
import { updatePublishedAppDeployment } from '../services/published-app-updater.js';
import { registerSessionSender } from '../tools/browser/browser-screencast.js';
import type { ProxyApprovalCallback, ProxyApprovalRequest } from '../tools/network/script-proxy/index.js';
import { projectSkillTools, type SkillProjectionCache } from './session-skill-tools.js';

// ── Context Interface ────────────────────────────────────────────────

/**
 * Subset of Session state that the tool executor callback reads at
 * call time (not construction time). These are captured by the
 * returned closure, so they must be live references.
 */
export interface ToolSetupContext extends SurfaceSessionContext {
  readonly conversationId: string;
  currentRequestId?: string;
  workingDir: string;
  sandboxOverride?: boolean;
  abortController: AbortController | null;
  /** When set, only tools in this set may execute during the current turn. */
  allowedToolNames?: Set<string>;
  /** Session memory policy — used to propagate scopeId and strictSideEffects into ToolContext. */
  memoryPolicy: { scopeId: string; strictSideEffects: boolean };
  /** True when the session has no connected IPC client (HTTP-only path). */
  hasNoClient?: boolean;
}

// ── buildToolDefinitions ─────────────────────────────────────────────

/**
 * Collect all tool definitions for the agent loop: built-in tools,
 * UI surface proxy tools, app proxy tools, and the computer-use
 * escalation tool.
 */
export function buildToolDefinitions(): ToolDefinition[] {
  return [
    ...getAllToolDefinitions(),
    ...allUiSurfaceTools.map((t) => t.getDefinition()),
    ...coreAppProxyTools.map((t) => t.getDefinition()),
    // Escalation tool: allows text_qa sessions to hand off to computer use
    requestComputerControlTool.getDefinition(),
  ];
}

// ── createToolExecutor ───────────────────────────────────────────────

/**
 * Build the tool executor callback that the AgentLoop calls for each
 * tool_use block. The returned function closes over `ctx` so it sees
 * live Session state (workingDir, currentRequestId, abortController,
 * etc.) at invocation time.
 */
export function createToolExecutor(
  executor: ToolExecutor,
  prompter: PermissionPrompter,
  secretPrompter: SecretPrompter,
  ctx: ToolSetupContext,
  handleToolLifecycleEvent: ToolLifecycleEventHandler,
  broadcastToAllClients?: (msg: ServerMessage) => void,
): (name: string, input: Record<string, unknown>, onOutput?: (chunk: string) => void) => Promise<ToolExecutionResult> {
  // Register the session's sendToClient for browser screencast surface messages
  registerSessionSender(ctx.conversationId, (msg) => ctx.sendToClient(msg));

  return async (name: string, input: Record<string, unknown>, onOutput?: (chunk: string) => void) => {
    const result = await executor.execute(name, input, {
      workingDir: ctx.workingDir,
      sessionId: ctx.conversationId,
      conversationId: ctx.conversationId,
      requestId: ctx.currentRequestId,
      onOutput,
      signal: ctx.abortController?.signal,
      sandboxOverride: ctx.sandboxOverride,
      allowedToolNames: ctx.allowedToolNames,
      memoryScopeId: ctx.memoryPolicy.scopeId,
      forcePromptSideEffects: ctx.memoryPolicy.strictSideEffects,
      onToolLifecycleEvent: handleToolLifecycleEvent,
      sendToClient: (msg) => {
        const serverMsg = msg as unknown as ServerMessage;
        ctx.sendToClient(serverMsg);
        // Auto-track ui_surface_show for history persistence, mirroring what
        // session-surfaces.ts does when sending surfaces through its own path.
        if (serverMsg.type === 'ui_surface_show') {
          const s = serverMsg as unknown as UiSurfaceShow;
          ctx.currentTurnSurfaces.push({
            surfaceId: s.surfaceId,
            surfaceType: s.surfaceType,
            title: s.title,
            data: s.data,
            actions: s.actions,
            display: s.display,
          });
        }
      },
      isInteractive: !ctx.hasNoClient,
      proxyToolResolver: (toolName: string, proxyInput: Record<string, unknown>) => surfaceProxyResolver(ctx, toolName, proxyInput),
      proxyApprovalCallback: createProxyApprovalCallback(prompter, ctx),
      requestSecret: async (params) => {
        return secretPrompter.prompt(
          params.service, params.field, params.label,
          params.description, params.placeholder,
          ctx.conversationId,
          params.purpose, params.allowedTools, params.allowedDomains,
        );
      },
      requestConfirmation: async (req) => {
        // Check trust store before prompting
        const existingRule = findHighestPriorityRule(
          'cc:' + req.toolName,
          [req.toolName, `cc:${req.toolName}`, 'cc:*'],
          ctx.workingDir,
        );
        if (existingRule && existingRule.decision !== 'ask') {
          return {
            decision: existingRule.decision === 'allow' ? 'allow' as const : 'deny' as const,
          };
        }
        const allowlistOptions = [
          { label: `cc:${req.toolName}`, description: `Claude Code ${req.toolName}`, pattern: `cc:${req.toolName}` },
          { label: 'cc:*', description: 'All Claude Code sub-tools', pattern: 'cc:*' },
        ];
        const scopeOptions = generateScopeOptions(ctx.workingDir);
        const response = await prompter.prompt(
          `cc:${req.toolName}`,
          req.input,
          req.riskLevel,
          allowlistOptions,
          scopeOptions,
          undefined, undefined,
          ctx.conversationId,
          req.executionTarget,
          req.principal,
        );
        if ((response.decision === 'always_allow' || response.decision === 'always_allow_high_risk') && response.selectedPattern && response.selectedScope) {
          addRule('cc:' + req.toolName, response.selectedPattern, response.selectedScope, 'allow', 100,
            response.decision === 'always_allow_high_risk' ? { allowHighRisk: true } : undefined);
        }
        if (response.decision === 'always_deny' && response.selectedPattern && response.selectedScope) {
          addRule('cc:' + req.toolName, response.selectedPattern, response.selectedScope, 'deny');
        }
        return {
          decision: (response.decision === 'allow' || response.decision === 'always_allow' || response.decision === 'always_allow_high_risk') ? 'allow' as const : 'deny' as const,
        };
      },
    });

    // Auto-refresh workspace surfaces when a persisted app is updated
    if (name === 'app_update' && !result.isError) {
      const appId = input.app_id as string | undefined;
      if (appId) {
        refreshSurfacesForApp(ctx, appId);
        broadcastToAllClients?.({ type: 'app_files_changed', appId });
        void updatePublishedAppDeployment(appId);
      }
    }

    // Tell the client to open/focus the tasks window when the model lists tasks
    if (name === 'task_list_show' && !result.isError) {
      ctx.sendToClient({ type: 'open_tasks_window' });
    }

    // Broadcast tasks_changed so connected clients (e.g. macOS Tasks window)
    // auto-refresh when the LLM mutates the task queue via tools
    if ((name === 'task_list_add' || name === 'task_list_update' || name === 'task_list_remove') && !result.isError) {
      broadcastToAllClients?.({ type: 'tasks_changed' });
    }

    // Auto-refresh workspace surfaces when app files are edited
    if ((name === 'app_file_edit' || name === 'app_file_write') && !result.isError) {
      const appId = input.app_id as string | undefined;
      const status = input.status as string | undefined;
      if (appId) {
        refreshSurfacesForApp(ctx, appId, { fileChange: true, status });
        broadcastToAllClients?.({ type: 'app_files_changed', appId });
        void updatePublishedAppDeployment(appId);
      }
    }

    // Auto-emit task_progress card on first DoorDash CLI command
    if (name === 'bash' && !result.isError) {
      const cmd = input.command as string | undefined;
      if (cmd?.includes('vellum doordash') && !ctx.surfaceState.has('doordash-progress')) {
        const surfaceId = 'doordash-progress';
        const data = {
          title: 'Ordering from DoorDash',
          body: '',
          template: 'task_progress' as const,
          templateData: {
            title: 'Ordering from DoorDash',
            status: 'in_progress',
            steps: [
              { label: 'Check session', status: 'in_progress' },
              { label: 'Search restaurants', status: 'pending' },
              { label: 'Browse menu', status: 'pending' },
              { label: 'Add to cart', status: 'pending' },
              { label: 'Place order', status: 'pending' },
            ],
          },
        } satisfies import('./ipc-contract.js').CardSurfaceData;
        ctx.surfaceState.set(surfaceId, { surfaceType: 'card', data });
        ctx.sendToClient({
          type: 'ui_surface_show',
          sessionId: ctx.conversationId,
          surfaceId,
          surfaceType: 'card',
          title: 'Ordering from DoorDash',
          data,
          display: 'inline',
        });
        ctx.currentTurnSurfaces.push({
          surfaceId,
          surfaceType: 'card',
          title: 'Ordering from DoorDash',
          data,
          display: 'inline',
        });
      }
    }

    return result;
  };
}

// ── createProxyApprovalCallback ──────────────────────────────────────

/**
 * Build a proxy approval callback that routes `ask_missing_credential` and
 * `ask_unauthenticated` policy decisions through the existing permission
 * prompter UI. The proxy service calls this when an outbound request needs
 * user confirmation before proceeding.
 */
export function createProxyApprovalCallback(
  prompter: PermissionPrompter,
  ctx: ToolSetupContext,
): ProxyApprovalCallback {
  return async (request: ProxyApprovalRequest): Promise<boolean> => {
    const { decision } = request;
    const { hostname, port, path } = decision.target;

    // Use the standard network_request tool name so trust rules align with
    // the checker's URL-based candidate generation and allowlist options.
    const toolName = 'network_request';
    const { scheme } = decision.target;
    const url = `${scheme}://${hostname}${port ? ':' + port : ''}${path}`;

    const input: Record<string, unknown> = {
      url,
      proxy_session_id: request.sessionId,
    };
    if (decision.kind === 'ask_missing_credential') {
      input.matching_patterns = decision.matchingPatterns;
    }

    const riskLevel = decision.kind === 'ask_missing_credential' ? 'high' : 'medium';

    // Check trust store before prompting — build candidates that mirror
    // buildCommandCandidates() in checker.ts for network_request.
    const candidates: string[] = [`${toolName}:${url}`];
    const normalized = normalizeWebFetchUrl(url);
    if (normalized) {
      candidates.push(`${toolName}:${normalized.href}`);
      candidates.push(`${toolName}:${normalized.origin}/*`);
    }
    candidates.push(`${toolName}:*`);
    // Deduplicate
    const uniqueCandidates = [...new Set(candidates)];

    const existingRule = findHighestPriorityRule(toolName, uniqueCandidates, ctx.workingDir);
    if (existingRule && existingRule.decision !== 'ask') {
      if (existingRule.decision === 'deny') return false;
      // For high-risk proxy decisions, a plain allow rule (without allowHighRisk)
      // must fall through to prompting — mirroring the checker's behavior.
      if (riskLevel !== 'high' || existingRule.allowHighRisk === true) return true;
    }

    // Use the checker's built-in allowlist generation for network_request
    const allowlistOptions = generateAllowlistOptions('network_request', { url });

    const scopeOptions = generateScopeOptions(ctx.workingDir);

    // Non-interactive sessions have no client to prompt — fast-deny to avoid
    // blocking for the full permission timeout before auto-denying.
    if (ctx.hasNoClient) {
      return false;
    }

    const response = await prompter.prompt(
      toolName,
      input,
      riskLevel,
      allowlistOptions,
      scopeOptions,
      undefined,
      undefined,
      ctx.conversationId,
    );

    // Persist trust rule if the user chose "always allow" or "always deny"
    if ((response.decision === 'always_allow' || response.decision === 'always_allow_high_risk') && response.selectedPattern && response.selectedScope) {
      addRule(toolName, response.selectedPattern, response.selectedScope, 'allow', 100,
        response.decision === 'always_allow_high_risk' ? { allowHighRisk: true } : undefined);
    }
    if (response.decision === 'always_deny' && response.selectedPattern && response.selectedScope) {
      addRule(toolName, response.selectedPattern, response.selectedScope, 'deny');
    }

    return response.decision === 'allow'
      || response.decision === 'always_allow'
      || response.decision === 'always_allow_high_risk';
  };
}

// ── createResolveToolsCallback ───────────────────────────────────────

/**
 * Subset of Session state that the resolveTools callback reads at each
 * agent turn. Properties are read lazily from this reference.
 */
export interface SkillProjectionContext {
  preactivatedSkillIds?: string[];
  readonly skillProjectionState: Map<string, string>;
  readonly skillProjectionCache: SkillProjectionCache;
  readonly coreToolNames: Set<string>;
  allowedToolNames?: Set<string>;
}

/**
 * Build a resolveTools callback that merges base tool definitions with
 * dynamically projected skill tools on each agent turn. Also updates
 * allowedToolNames so newly-activated skill tools aren't blocked by
 * the executor's stale gate.
 */
export function createResolveToolsCallback(
  toolDefs: ToolDefinition[],
  ctx: SkillProjectionContext,
): ((history: Message[]) => ToolDefinition[]) | undefined {
  if (toolDefs.length === 0) return undefined;

  return (history: Message[]) => {
    const projection = projectSkillTools(history, {
      preactivatedSkillIds: ctx.preactivatedSkillIds,
      previouslyActiveSkillIds: ctx.skillProjectionState,
      cache: ctx.skillProjectionCache,
    });
    const turnAllowed = new Set(ctx.coreToolNames);
    for (const name of projection.allowedToolNames) {
      turnAllowed.add(name);
    }
    ctx.allowedToolNames = turnAllowed;
    return [...toolDefs, ...projection.toolDefinitions];
  };
}
