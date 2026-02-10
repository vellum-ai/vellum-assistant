import { NextResponse } from "next/server";

import {
  getAssistantConnectionMode,
  getLocalDaemonSocketPath,
} from "@/lib/assistant-connection";
import { Assistant, getDb } from "@/lib/db";
import { getInstanceExternalIp, getInstanceStatus } from "@/lib/gcp";
import {
  LocalDaemonClient,
  describeLocalDaemonError,
} from "@/lib/local-daemon-ipc";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

function cloudResponse(payload: Record<string, unknown>) {
  return NextResponse.json({
    connectionMode: "cloud",
    ...payload,
  });
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;

    const sql = getDb();
    const result = await sql`SELECT * FROM assistants WHERE id = ${assistantId}`;

    if (result.length === 0) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const connectionMode = getAssistantConnectionMode();
    if (connectionMode === "local") {
      const socketPath = getLocalDaemonSocketPath();
      let daemon: LocalDaemonClient | null = null;
      let reachable = false;
      let errorDetail: string | null = null;

      try {
        daemon = await LocalDaemonClient.connect(socketPath);
        await daemon.ping(3000);
        reachable = true;
      } catch (error: unknown) {
        reachable = false;
        errorDetail = describeLocalDaemonError(error);
      } finally {
        daemon?.close();
      }

      return NextResponse.json({
        status: reachable ? "healthy" : "unreachable",
        message: reachable
          ? "Connected to local daemon"
          : "Local daemon is not reachable",
        connectionMode: "local",
        daemon: {
          socketPath,
          reachable,
          ...(errorDetail ? { error: errorDetail } : {}),
        },
      });
    }

    const assistant = result[0] as Assistant;
    const computeConfig = (assistant.configuration as Record<string, unknown>)?.compute as
      | { instanceName?: string; zone?: string }
      | undefined;

    // If no compute instance is configured, report as healthy so the chat UI is usable
    // TODO: Remove this once we have a way to reproduce our production environment kubernetes locally
    if (!computeConfig?.instanceName || !computeConfig?.zone) {
      return cloudResponse({
        status: "healthy",
        message: "Running in demo mode",
      });
    }

    const provisioningError = (assistant.configuration as Record<string, unknown>)?.provisioningError as string | undefined;
    if (provisioningError) {
      return cloudResponse({
        status: "provisioning_failed",
        message: provisioningError,
      });
    }

    const externalIp = await getInstanceExternalIp(
      computeConfig.instanceName,
      computeConfig.zone
    );

    if (!externalIp) {
      const instanceStatus = await getInstanceStatus(
        computeConfig.instanceName,
        computeConfig.zone
      );

      if (
        instanceStatus === "STAGING" ||
        instanceStatus === "PROVISIONING" ||
        instanceStatus === "RUNNING"
      ) {
        return cloudResponse({
          status: "starting",
          message: "Agent instance is starting up",
        });
      }

      return cloudResponse({
        status: "stopped",
        message: "Instance has no external IP (likely stopped)",
      });
    }

    try {
      const healthUrl = `http://${externalIp}:8080/health`;
      const response = await fetch(healthUrl, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return cloudResponse({
          status: "unhealthy",
          message: `Health check returned ${response.status}`,
          ip: externalIp,
        });
      }

      const healthData = await response.json();

      if (healthData.status === "setting_up") {
        return cloudResponse({
          status: "setting_up",
          progress: healthData.progress || null,
          ip: externalIp,
        });
      }

      if (healthData.status === "error") {
        return cloudResponse({
          status: "provisioning_failed",
          message: healthData.error || healthData.progress || "Setup failed",
          ip: externalIp,
        });
      }

      // Also fetch system stats
      let stats = null;
      try {
        const statsUrl = `http://${externalIp}:8080/stats`;
        const statsResponse = await fetch(statsUrl, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(3000),
        });
        if (statsResponse.ok) {
          stats = await statsResponse.json();
        }
      } catch {
        // Stats fetch failed, continue without them
      }

      return cloudResponse({
        status: "healthy",
        data: healthData,
        ip: externalIp,
        stats,
      });
    } catch (fetchError: unknown) {
      console.log("Health check failed:", fetchError);
      const errorDetail = fetchError instanceof Error ? fetchError.message : "Unknown error";
      return cloudResponse({
        status: "unreachable",
        message: `Health check failed: ${errorDetail}`,
        ip: externalIp,
      });
    }
  } catch (error: unknown) {
    console.error("Error checking assistant health:", error);
    return NextResponse.json(
      { error: "Failed to check assistant health" },
      { status: 500 }
    );
  }
}
