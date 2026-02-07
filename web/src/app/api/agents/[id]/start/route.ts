import { NextResponse } from "next/server";

import { Agent, getDb } from "@/lib/db";
import { startInstance } from "@/lib/gcp";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: agentId } = await params;

    const sql = getDb();
    const result = await sql`SELECT * FROM agents WHERE id = ${agentId}`;

    if (result.length === 0) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const agent = result[0] as Agent;
    const computeConfig = agent.configuration?.compute as
      | { instanceName?: string; zone?: string }
      | undefined;

    if (!computeConfig?.instanceName || !computeConfig?.zone) {
      return NextResponse.json(
        { error: "No compute instance configured for this agent" },
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
  } catch (error) {
    console.error("Error starting agent:", error);
    return NextResponse.json(
      { error: "Failed to start agent" },
      { status: 500 }
    );
  }
}
