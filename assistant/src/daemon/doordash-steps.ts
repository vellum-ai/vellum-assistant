/**
 * DoorDash-specific step-tracking logic for the task_progress surface.
 *
 * Extracted from session-tool-setup.ts so the generic tool executor
 * remains clean and extensible.
 */

import { isPlainObject } from "../util/object.js";
import type { ToolSetupContext } from "./conversation-tool-setup.js";
import type { CardSurfaceData } from "./message-protocol.js";

interface DoordashStep {
  label: string;
  status: string;
  detail?: string;
}

const SURFACE_ID = "doordash-progress";

/**
 * Map a DoorDash CLI invocation (`doordash <subcommand>`,
 * `vellum doordash <subcommand>`, or `bun .../doordash-entry.ts <subcommand>`)
 * to the step label it corresponds to.
 */
function doordashCommandToStep(cmd: string): string | undefined {
  // Match standalone `doordash`, legacy `vellum doordash`, and `bun .../doordash-entry.ts` prefixes
  const dd = /(?:vellum )?(?:doordash|bun\s+\S*doordash-entry\.ts) /;
  if (
    new RegExp(dd.source + "status\\b").test(cmd) ||
    new RegExp(dd.source + "refresh\\b").test(cmd) ||
    new RegExp(dd.source + "login\\b").test(cmd)
  )
    return "Check session";
  if (
    new RegExp(dd.source + "search\\b").test(cmd) ||
    new RegExp(dd.source + "search-items\\b").test(cmd)
  )
    return "Search restaurants";
  if (
    new RegExp(dd.source + "menu\\b").test(cmd) ||
    new RegExp(dd.source + "item\\b").test(cmd) ||
    new RegExp(dd.source + "store-search\\b").test(cmd)
  )
    return "Browse menu";
  if (new RegExp(dd.source + "cart\\b").test(cmd)) return "Add to cart";
  if (
    new RegExp(dd.source + "checkout\\b").test(cmd) ||
    new RegExp(dd.source + "payment-methods\\b").test(cmd)
  )
    return "Add to cart";
  if (new RegExp(dd.source + "order\\b").test(cmd)) return "Place order";
  return undefined;
}

/**
 * Given a completed DoorDash CLI command, return updated steps array or null if no change.
 */
function updateDoordashSteps(
  cmd: string,
  steps: DoordashStep[],
  isError: boolean,
): DoordashStep[] | undefined {
  const stepLabel = doordashCommandToStep(cmd);
  if (!stepLabel) return undefined;

  const stepIndex = steps.findIndex((s) => s.label === stepLabel);
  if (stepIndex < 0) return undefined;

  const updated = steps.map((s, i) => {
    if (i < stepIndex) {
      // Steps before current should be completed
      return s.status === "completed" ? s : { ...s, status: "completed" };
    }
    if (i === stepIndex) {
      if (isError) {
        // If the command failed, mark as in_progress still (will retry)
        return { ...s, status: "in_progress" };
      }
      return { ...s, status: "completed" };
    }
    if (i === stepIndex + 1 && !isError) {
      // Next step becomes waiting (user may need to respond before it starts)
      return { ...s, status: "waiting" };
    }
    return s;
  });

  return updated;
}

// ── Helpers for reading/writing the task_progress surface ─────────────

function getStoredSteps(ctx: ToolSetupContext): DoordashStep[] | null {
  const stored = ctx.surfaceState.get(SURFACE_ID);
  if (!stored || stored.surfaceType !== "card") return null;
  const card = stored.data as CardSurfaceData;
  if (card.template !== "task_progress" || !isPlainObject(card.templateData))
    return null;
  const steps = (card.templateData as Record<string, unknown>).steps;
  return Array.isArray(steps) ? (steps as DoordashStep[]) : null;
}

function pushStepsUpdate(
  ctx: ToolSetupContext,
  updatedSteps: DoordashStep[],
): void {
  const stored = ctx.surfaceState.get(SURFACE_ID)!;
  const card = stored.data as CardSurfaceData;
  const updatedTemplateData = {
    ...(card.templateData as Record<string, unknown>),
    steps: updatedSteps,
  };
  const updatedData = { ...card, templateData: updatedTemplateData };
  stored.data = updatedData as CardSurfaceData;
  ctx.sendToClient({
    type: "ui_surface_update",
    conversationId: ctx.conversationId,
    surfaceId: SURFACE_ID,
    data: updatedData,
  });
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Returns true if the given tool invocation is a DoorDash CLI command
 * that should be tracked.
 */
export function isDoordashCommand(
  name: string,
  input: Record<string, unknown>,
): boolean {
  if (name !== "bash" && name !== "host_bash") return false;
  const cmd = input.command as string | undefined;
  return !!cmd && doordashCommandToStep(cmd) !== undefined;
}

/**
 * Pre-execution hook: mark the matching DoorDash step as in_progress
 * before the command runs.
 */
export function markDoordashStepInProgress(
  ctx: ToolSetupContext,
  input: Record<string, unknown>,
): void {
  const cmd = input.command as string | undefined;
  const stepLabel = cmd ? doordashCommandToStep(cmd) : null;
  if (!stepLabel) return;

  const steps = getStoredSteps(ctx);
  if (!steps) return;

  const stepIndex = steps.findIndex((s) => s.label === stepLabel);
  if (stepIndex < 0 || steps[stepIndex].status === "in_progress") return;

  const updatedSteps = steps.map((s, i) =>
    i === stepIndex ? { ...s, status: "in_progress" } : s,
  );
  pushStepsUpdate(ctx, updatedSteps);
}

/**
 * Post-execution hook: auto-emit the task_progress card on first
 * DoorDash CLI command, then update step statuses based on the result.
 */
export function updateDoordashProgress(
  ctx: ToolSetupContext,
  input: Record<string, unknown>,
  isError: boolean,
): void {
  const cmd = input.command as string | undefined;
  if (!cmd || !doordashCommandToStep(cmd)) return;

  if (!ctx.surfaceState.has(SURFACE_ID)) {
    // First DoorDash command — auto-emit the task_progress card
    const data = {
      title: "Ordering from DoorDash",
      body: "",
      template: "task_progress" as const,
      templateData: {
        title: "Ordering from DoorDash",
        status: "in_progress",
        steps: [
          { label: "Check session", status: "in_progress" },
          { label: "Search restaurants", status: "pending" },
          { label: "Browse menu", status: "pending" },
          { label: "Add to cart", status: "pending" },
          { label: "Place order", status: "pending" },
        ],
      },
    } satisfies CardSurfaceData;
    ctx.surfaceState.set(SURFACE_ID, { surfaceType: "card", data });
    ctx.sendToClient({
      type: "ui_surface_show",
      conversationId: ctx.conversationId,
      surfaceId: SURFACE_ID,
      surfaceType: "card",
      title: "Ordering from DoorDash",
      data,
      display: "inline",
    });
    ctx.currentTurnSurfaces.push({
      surfaceId: SURFACE_ID,
      surfaceType: "card",
      title: "Ordering from DoorDash",
      data,
      display: "inline",
    });
  }

  // Auto-update step statuses based on the command that just ran
  const steps = getStoredSteps(ctx);
  if (!steps) return;

  const updatedSteps = updateDoordashSteps(cmd, steps, isError);
  if (updatedSteps) {
    pushStepsUpdate(ctx, updatedSteps);
  }
}
