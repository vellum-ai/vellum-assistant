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
import { getLogger } from '../util/logger.js';

const log = getLogger('session-tool-setup');
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
import { openAppViaSurface } from '../tools/apps/open-proxy.js';
import { registerSessionSender } from '../tools/browser/browser-screencast.js';
import type { ProxyApprovalCallback, ProxyApprovalRequest } from '../tools/network/script-proxy/index.js';
import { projectSkillTools, type SkillProjectionCache } from './session-skill-tools.js';
import { getConfig } from '../config/loader.js';

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
  /** When true, the session is executing a task run and must not become interactive. */
  headlessLock?: boolean;
  /** When set, this session is executing a task run. Used to retrieve ephemeral permission rules. */
  taskRunId?: string;
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

// ── DoorDash task_progress auto-update ────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface DoordashStep { label: string; status: string; detail?: string }

/**
 * Map a `vellum doordash <subcommand>` to the step label it corresponds to.
 */
function doordashCommandToStep(cmd: string): string | null {
  if (/vellum doordash status\b/.test(cmd) || /vellum doordash refresh\b/.test(cmd) || /vellum doordash login\b/.test(cmd)) return 'Check session';
  if (/vellum doordash search\b/.test(cmd) || /vellum doordash search-items\b/.test(cmd)) return 'Search restaurants';
  if (/vellum doordash menu\b/.test(cmd) || /vellum doordash item\b/.test(cmd) || /vellum doordash store-search\b/.test(cmd)) return 'Browse menu';
  if (/vellum doordash cart\b/.test(cmd)) return 'Add to cart';
  if (/vellum doordash checkout\b/.test(cmd) || /vellum doordash payment-methods\b/.test(cmd)) return 'Add to cart';
  if (/vellum doordash order\b/.test(cmd)) return 'Place order';
  return null;
}

/**
 * Given a completed DoorDash CLI command, return updated steps array or null if no change.
 */
function updateDoordashSteps(cmd: string, steps: DoordashStep[], isError: boolean): DoordashStep[] | null {
  const stepLabel = doordashCommandToStep(cmd);
  if (!stepLabel) return null;

  const stepIndex = steps.findIndex(s => s.label === stepLabel);
  if (stepIndex < 0) return null;

  const updated = steps.map((s, i) => {
    if (i < stepIndex) {
      // Steps before current should be completed
      return s.status === 'completed' ? s : { ...s, status: 'completed' };
    }
    if (i === stepIndex) {
      if (isError) {
        // If the command failed, mark as in_progress still (will retry)
        return { ...s, status: 'in_progress' };
      }
      return { ...s, status: 'completed' };
    }
    if (i === stepIndex + 1 && !isError) {
      // Next step becomes waiting (user may need to respond before it starts)
      return { ...s, status: 'waiting' };
    }
    return s;
  });

  return updated;
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
    // Pre-execution: mark the current DoorDash step as in_progress when command starts
    if (name === 'bash' || name === 'host_bash') {
      const preCmd = input.command as string | undefined;
      if (preCmd?.includes('vellum doordash')) {
        const surfaceId = 'doordash-progress';
        const stored = ctx.surfaceState.get(surfaceId);
        if (stored && stored.surfaceType === 'card') {
          const card = stored.data as import('./ipc-contract.js').CardSurfaceData;
          if (card.template === 'task_progress' && isPlainObject(card.templateData)) {
            const steps = (card.templateData as Record<string, unknown>).steps;
            if (Array.isArray(steps)) {
              const stepLabel = doordashCommandToStep(preCmd);
              if (stepLabel) {
                const stepIndex = (steps as DoordashStep[]).findIndex(s => s.label === stepLabel);
                if (stepIndex >= 0 && (steps as DoordashStep[])[stepIndex].status !== 'in_progress') {
                  const updatedSteps = (steps as DoordashStep[]).map((s, i) =>
                    i === stepIndex ? { ...s, status: 'in_progress' } : s
                  );
                  const updatedTemplateData = { ...card.templateData as Record<string, unknown>, steps: updatedSteps };
                  const updatedData = { ...card, templateData: updatedTemplateData };
                  stored.data = updatedData as import('./ipc-contract.js').CardSurfaceData;
                  ctx.sendToClient({
                    type: 'ui_surface_update',
                    sessionId: ctx.conversationId,
                    surfaceId,
                    data: updatedData,
                  });
                }
              }
            }
          }
        }
      }
    }

    const result = await executor.execute(name, input, {
      workingDir: ctx.workingDir,
      sessionId: ctx.conversationId,
      conversationId: ctx.conversationId,
      requestId: ctx.currentRequestId,
      taskRunId: ctx.taskRunId,
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
      isInteractive: !ctx.hasNoClient && !ctx.headlessLock,
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
          log.info({ toolName: 'cc:' + req.toolName, pattern: response.selectedPattern, scope: response.selectedScope, highRisk: response.decision === 'always_allow_high_risk' }, 'Persisting always-allow trust rule');
          addRule('cc:' + req.toolName, response.selectedPattern, response.selectedScope, 'allow', 100,
            response.decision === 'always_allow_high_risk' ? { allowHighRisk: true } : undefined);
        }
        if (response.decision === 'always_deny' && response.selectedPattern && response.selectedScope) {
          log.info({ toolName: 'cc:' + req.toolName, pattern: response.selectedPattern, scope: response.selectedScope }, 'Persisting always-deny trust rule');
          addRule('cc:' + req.toolName, response.selectedPattern, response.selectedScope, 'deny');
        }
        return {
          decision: (response.decision === 'allow' || response.decision === 'always_allow' || response.decision === 'always_allow_high_risk') ? 'allow' as const : 'deny' as const,
        };
      },
    });

    // Auto-refresh workspace surfaces when a persisted app is updated.
    // If no surface is currently showing the app, auto-open it.
    if (name === 'app_update' && !result.isError) {
      const appId = input.app_id as string | undefined;
      if (appId) {
        const refreshed = refreshSurfacesForApp(ctx, appId);
        broadcastToAllClients?.({ type: 'app_files_changed', appId });
        void updatePublishedAppDeployment(appId);
        if (!refreshed && !ctx.hasNoClient && !ctx.headlessLock) {
          const resolver = (tn: string, pi: Record<string, unknown>) => surfaceProxyResolver(ctx, tn, pi);
          void openAppViaSurface(appId, resolver);
        }
      }
    }

    // Tell the client to open/focus the tasks window when the model lists tasks
    if (name === 'task_list_show' && !result.isError) {
      ctx.sendToClient({ type: 'open_tasks_window' });
    }

    // Broadcast tasks_changed so connected clients (e.g. macOS Tasks window)
    // auto-refresh when the LLM mutates the task queue via tools
    if ((name === 'task_list_add' || name === 'task_list_update' || name === 'task_list_remove' || name === 'task_queue_run') && !result.isError) {
      broadcastToAllClients?.({ type: 'tasks_changed' });
    }

    // Auto-refresh workspace surfaces when app files are edited.
    // If no surface is currently showing the app, auto-open it.
    if ((name === 'app_file_edit' || name === 'app_file_write') && !result.isError) {
      const appId = input.app_id as string | undefined;
      const status = input.status as string | undefined;
      if (appId) {
        const refreshed = refreshSurfacesForApp(ctx, appId, { fileChange: true, status });
        broadcastToAllClients?.({ type: 'app_files_changed', appId });
        void updatePublishedAppDeployment(appId);
        if (!refreshed && !ctx.hasNoClient && !ctx.headlessLock) {
          const resolver = (tn: string, pi: Record<string, unknown>) => surfaceProxyResolver(ctx, tn, pi);
          void openAppViaSurface(appId, resolver);
        }
      }
    }

    // Auto-emit task_progress card on first DoorDash CLI command
    if (name === 'bash' || name === 'host_bash') {
      const cmd = input.command as string | undefined;
      if (cmd?.includes('vellum doordash')) {
        const surfaceId = 'doordash-progress';

        if (!ctx.surfaceState.has(surfaceId)) {
          // First DoorDash command — auto-emit the task_progress card
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

        // Auto-update step statuses based on the command that just ran
        const stored = ctx.surfaceState.get(surfaceId);
        if (stored && stored.surfaceType === 'card') {
          const card = stored.data as import('./ipc-contract.js').CardSurfaceData;
          if (card.template === 'task_progress' && isPlainObject(card.templateData)) {
            const steps = (card.templateData as Record<string, unknown>).steps;
            if (Array.isArray(steps)) {
              const updatedSteps = updateDoordashSteps(cmd, steps as Array<{ label: string; status: string; detail?: string }>, result.isError);
              if (updatedSteps) {
                const updatedTemplateData = { ...card.templateData as Record<string, unknown>, steps: updatedSteps };
                const updatedData = { ...card, templateData: updatedTemplateData };
                stored.data = updatedData as import('./ipc-contract.js').CardSurfaceData;
                ctx.sendToClient({
                  type: 'ui_surface_update',
                  sessionId: ctx.conversationId,
                  surfaceId,
                  data: updatedData,
                });
              }
            }
          }
        }
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
    if (getConfig().permissions.mode === 'workspace_full_access') {
      return true;
    }

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
      log.info({ toolName, pattern: response.selectedPattern, scope: response.selectedScope, highRisk: response.decision === 'always_allow_high_risk' }, 'Persisting always-allow trust rule (proxy)');
      addRule(toolName, response.selectedPattern, response.selectedScope, 'allow', 100,
        response.decision === 'always_allow_high_risk' ? { allowHighRisk: true } : undefined);
    }
    if (response.decision === 'always_deny' && response.selectedPattern && response.selectedScope) {
      log.info({ toolName, pattern: response.selectedPattern, scope: response.selectedScope }, 'Persisting always-deny trust rule (proxy)');
      addRule(toolName, response.selectedPattern, response.selectedScope, 'deny');
    }

    return response.decision === 'allow'
      || response.decision === 'always_allow'
      || response.decision === 'always_allow_high_risk';
  };
}

// ── createResolveToolsCallback ───────────────────────────────────────

/**
 * Bundled skills that must always be active regardless of conversation
 * history or explicit preactivation. Without this, their tools are
 * unavailable in fresh sessions until `skill_load` is called.
 */
const DEFAULT_PREACTIVATED_SKILL_IDS = ['tasks'];

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
    const effectivePreactivated = [
      ...DEFAULT_PREACTIVATED_SKILL_IDS,
      ...(ctx.preactivatedSkillIds ?? []),
    ];
    const projection = projectSkillTools(history, {
      preactivatedSkillIds: effectivePreactivated,
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
