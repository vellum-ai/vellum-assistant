import { NextResponse } from "next/server";

import { Assistant, getDb } from "@/lib/db";
import { getInstanceExternalIp, getInstanceStatus } from "@/lib/gcp";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;

    const sql = getDb();
    const result = await sql`SELECT * FROM assistants WHERE id = ${assistantId}`;

    if (result.length === 0) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const assistant = result[0] as Assistant;
    const computeConfig = (assistant.configuration as Record<string, unknown>)?.compute as
      | { instanceName?: string; zone?: string }
      | undefined;

    // In local dev, there's no compute instance - report as healthy so the UI is usable
    // TODO: Remove this once we have a way to reproduce our production environment kubernetes locally
    if (process.env.NODE_ENV !== "production") {
      return NextResponse.json({
        status: "healthy",
        message: "Running in local development mode",
      });
    }

    const provisioningError = (assistant.configuration as Record<string, unknown>)?.provisioningError as string | undefined;
    if (provisioningError) {
      return NextResponse.json({
        status: "provisioning_failed",
        message: provisioningError,
      });
    }

    if (!computeConfig?.instanceName || !computeConfig?.zone) {
      return NextResponse.json({
        status: "unknown",
        message: "No compute instance configured",
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
        return NextResponse.json({
          status: "starting",
          message: "Agent instance is starting up",
        });
      }

      return NextResponse.json({
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
        return NextResponse.json({
          status: "unhealthy",
          message: `Health check returned ${response.status}`,
          ip: externalIp,
        });
      }

      const healthData = await response.json();

      if (healthData.status === "setting_up") {
        return NextResponse.json({
          status: "setting_up",
          progress: healthData.progress || null,
          ip: externalIp,
        });
      }

      if (healthData.status === "error") {
        return NextResponse.json({
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

      return NextResponse.json({
        status: "healthy",
        data: healthData,
        ip: externalIp,
        stats,
      });
    } catch (fetchError: unknown) {
      console.log("Health check failed:", fetchError);
      const errorDetail = fetchError instanceof Error ? fetchError.message : "Unknown error";
      return NextResponse.json({
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
