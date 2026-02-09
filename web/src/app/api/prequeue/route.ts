import { NextResponse } from "next/server";

import {
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

    const totalReady = instances.filter((i) => i.ready).length;
    const totalStarting = instances.filter(
      (i) => !i.ready && (i.status === "RUNNING" || i.status === "STAGING")
    ).length;

    return NextResponse.json({
      instances,
      summary: {
        total: instances.length,
        ready: totalReady,
        starting: totalStarting,
      },
      totalInstances: instances.length,
      totalReady,
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
 * - { action: "create" } - Create a single prequeued instance
 * - { action: "ensure", minSize?: number } - Ensure pool has minimum instances
 * - { action: "cleanup", maxAgeHours?: number } - Clean up stale instances
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, minSize = 1, maxAgeHours = 24 } = body;

    switch (action) {
      case "create": {
        const result = await createPrequeuedInstance();
        return NextResponse.json({
          success: true,
          action: "create",
          instance: result,
        });
      }

      case "ensure": {
        const result = await ensurePrequeuePool(minSize);
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
