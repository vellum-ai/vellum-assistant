import { NextResponse } from "next/server";

import {
  AgentType,
  cleanupStalePrequeueInstances,
  createPrequeuedInstance,
  ensurePrequeuePool,
  listPrequeuedInstances,
} from "@/lib/gcp";

/**
 * GET /api/prequeue - List prequeued instances and pool status
 */
export async function GET() {
  try {
    const instances = await listPrequeuedInstances();

    const byType: Record<string, { total: number; ready: number; starting: number }> = {};

    for (const instance of instances) {
      if (!byType[instance.agentType]) {
        byType[instance.agentType] = { total: 0, ready: 0, starting: 0 };
      }
      byType[instance.agentType].total++;
      if (instance.ready) {
        byType[instance.agentType].ready++;
      } else if (instance.status === "RUNNING" || instance.status === "STAGING") {
        byType[instance.agentType].starting++;
      }
    }

    return NextResponse.json({
      instances,
      summary: byType,
      totalInstances: instances.length,
      totalReady: instances.filter((i) => i.ready).length,
    });
  } catch (error) {
    console.error("Error listing prequeue instances:", error);
    return NextResponse.json(
      { error: "Failed to list prequeue instances" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/prequeue - Manage prequeue pool
 *
 * Actions:
 * - { action: "create", agentType?: "vellyclaw" | "simple" } - Create a single prequeued instance
 * - { action: "ensure", agentType?: string, minSize?: number } - Ensure pool has minimum instances
 * - { action: "cleanup", maxAgeHours?: number } - Clean up stale instances
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, agentType = "vellyclaw", minSize = 1, maxAgeHours = 24 } = body;

    switch (action) {
      case "create": {
        const result = await createPrequeuedInstance(agentType as AgentType);
        return NextResponse.json({
          success: true,
          action: "create",
          instance: result,
        });
      }

      case "ensure": {
        const result = await ensurePrequeuePool(agentType as AgentType, minSize);
        return NextResponse.json({
          success: true,
          action: "ensure",
          ...result,
        });
      }

      case "cleanup": {
        const deleted = await cleanupStalePrequeueInstances(maxAgeHours);
        return NextResponse.json({
          success: true,
          action: "cleanup",
          deleted,
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error("Error in prequeue action:", error);
    return NextResponse.json(
      { error: "Failed to perform prequeue action" },
      { status: 500 }
    );
  }
}
