import { NextResponse } from "next/server";

import { getAssistantConnectionMode } from "@/lib/assistant-connection";
import { Assistant, getDb } from "@/lib/db";
import { startInstance } from "@/lib/gcp";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;

    const sql = getDb();
    const result = await sql`SELECT * FROM assistants WHERE id = ${assistantId}`;

    if (result.length === 0) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    if (getAssistantConnectionMode() === "local") {
      return NextResponse.json(
        {
          error:
            "Start is not supported in local-daemon mode. Manage daemon lifecycle outside the web UI.",
          connectionMode: "local",
        },
        { status: 501 }
      );
    }

    const assistant = result[0] as Assistant;
    const computeConfig = (assistant.configuration as Record<string, unknown>)?.compute as
      | { instanceName?: string; zone?: string }
      | undefined;

    if (!computeConfig?.instanceName || !computeConfig?.zone) {
      return NextResponse.json(
        { error: "No compute instance configured for this assistant" },
        { status: 400 }
      );
    }

    const success = await startInstance(
      computeConfig.instanceName,
      computeConfig.zone
    );

    if (!success) {
      return NextResponse.json(
        { error: "Failed to start instance" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: `Instance ${computeConfig.instanceName} is starting`,
    });
  } catch (error: unknown) {
    console.error("Error starting assistant:", error);
    return NextResponse.json(
      { error: "Failed to start assistant" },
      { status: 500 }
    );
  }
}
