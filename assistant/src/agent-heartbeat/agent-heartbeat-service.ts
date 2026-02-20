import { readFileSync, existsSync } from 'node:fs';
import { getLogger } from '../util/logger.js';
import { getWorkspacePromptPath } from '../util/platform.js';
import { getConfig } from '../config/loader.js';
import { createConversation } from '../memory/conversation-store.js';
import type { AgentHeartbeatAlert } from '../daemon/ipc-contract.js';

const log = getLogger('agent-heartbeat');

const DEFAULT_CHECKLIST = `- Check the current weather and note anything notable
- Review any recent news headlines worth flagging
- Look for calendar events or reminders coming up soon`;

export interface AgentHeartbeatDeps {
  processMessage: (conversationId: string, content: string) => Promise<{ messageId: string }>;
  alerter: (alert: AgentHeartbeatAlert) => void;
  /** Override for current hour (0-23), for testing. */
  getCurrentHour?: () => number;
}

export class AgentHeartbeatService {
  private readonly deps: AgentHeartbeatDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeRun: Promise<void> | null = null;

  constructor(deps: AgentHeartbeatDeps) {
    this.deps = deps;
  }

  start(): void {
    const config = getConfig().agentHeartbeat;
    if (!config.enabled) {
      log.info('Agent heartbeat disabled by config');
      return;
    }
    if (this.timer) return;

    log.info({ intervalMs: config.intervalMs }, 'Agent heartbeat service started');
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        log.error({ err }, 'Agent heartbeat runOnce failed');
      });
    }, config.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeRun) {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      await Promise.race([this.activeRun, timeout]);
    }
    log.info('Agent heartbeat service stopped');
  }

  async runOnce(): Promise<void> {
    const config = getConfig().agentHeartbeat;
    if (!config.enabled) return;

    // Active hours guard — only applied when both bounds are set.
    // The schema rejects configs where only one bound is provided.
    if (config.activeHoursStart != null && config.activeHoursEnd != null) {
      const hour = this.deps.getCurrentHour?.() ?? new Date().getHours();
      if (!isWithinActiveHours(hour, config.activeHoursStart, config.activeHoursEnd)) {
        log.debug({ hour, activeHoursStart: config.activeHoursStart, activeHoursEnd: config.activeHoursEnd }, 'Outside active hours, skipping');
        return;
      }
    }

    // Overlap prevention
    if (this.activeRun) {
      log.debug('Previous heartbeat run still active, skipping');
      return;
    }

    const run = this.executeRun();
    this.activeRun = run;
    try {
      await run;
    } finally {
      this.activeRun = null;
    }
  }

  private async executeRun(): Promise<void> {
    log.info('Running agent heartbeat');

    try {
      const checklist = this.readChecklist();
      const prompt = this.buildPrompt(checklist);

      const conversation = createConversation({
        title: 'Agent Heartbeat',
        threadType: 'background',
      });

      await this.deps.processMessage(conversation.id, prompt);
      log.info({ conversationId: conversation.id }, 'Agent heartbeat completed');
    } catch (err) {
      log.error({ err }, 'Agent heartbeat failed');
      try {
        this.deps.alerter({
          type: 'agent_heartbeat_alert',
          title: 'Agent Heartbeat Failed',
          body: err instanceof Error ? err.message : String(err),
        });
      } catch (alertErr) {
        log.warn({ alertErr }, 'Failed to broadcast heartbeat alert');
      }
    }
  }

  private readChecklist(): string {
    const heartbeatPath = getWorkspacePromptPath('HEARTBEAT.md');
    if (existsSync(heartbeatPath)) {
      try {
        return readFileSync(heartbeatPath, 'utf-8');
      } catch (err) {
        log.warn({ err, heartbeatPath }, 'Failed to read HEARTBEAT.md, using default checklist');
      }
    }
    return DEFAULT_CHECKLIST;
  }

  /** @internal Exposed for testing. */
  buildPrompt(checklist: string): string {
    return `You are running a periodic heartbeat check. Review the following checklist and take any necessary actions.

<heartbeat-checklist>
${checklist}
</heartbeat-checklist>

<heartbeat-disposition>
After completing your review, end your response with one of:
- HEARTBEAT_OK — if everything looks good, no action needed
- HEARTBEAT_ALERT — if you found issues that need attention (describe them before this marker)
</heartbeat-disposition>`;
  }
}

/**
 * Check if the given hour falls within the active window.
 * Handles overnight windows (e.g. start=22, end=6).
 */
function isWithinActiveHours(hour: number, start: number, end: number): boolean {
  if (start <= end) {
    return hour >= start && hour < end;
  }
  // Overnight window: e.g. 22-6 means 22,23,0,1,2,3,4,5
  return hour >= start || hour < end;
}
