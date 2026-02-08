import { NextResponse } from "next/server";

import { Agent, getDb } from "@/lib/db";
import { stopInstance } from "@/lib/gcp";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: agentId } = await params;

    const sql = getDb();
    const result = await sql`SELECT * FROM assistants WHERE id = ${agentId}`;

    if (result.length === 0) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const agent = result[0] as Agent;
    const computeConfig = (agent.configuration as Record<string, unknown>)?.compute as
      | { instanceName?: string; zone?: string }
      | undefined;

    if (!computeConfig?.instanceName || !computeConfig?.zone) {
      return NextResponse.json(
        { error: "No compute instance configured for this agent" },
        { status: 400 }
      );
    }

    const success = await stopInstance(
      computeConfig.instanceName,
      computeConfig.zone
    );

    if (!success) {
      return NextResponse.json(
        { error: "Failed to stop instance" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: `Instance ${computeConfig.instanceName} is stopping`,
    });
  } catch (error: unknown) {
    console.error("Error stopping agent:", error);
    return NextResponse.json(
      { error: "Failed to stop agent" },
      { status: 500 }
    );
  }
}
