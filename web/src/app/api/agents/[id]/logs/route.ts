import { NextRequest, NextResponse } from "next/server";

import { Agent, getDb } from "@/lib/db";
import { getInstanceExternalIp } from "@/lib/gcp";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: agentId } = await params;
    const date = request.nextUrl.searchParams.get("date");

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
        { error: "No compute instance configured" },
        { status: 400 }
      );
    }

    const externalIp = await getInstanceExternalIp(
      computeConfig.instanceName,
      computeConfig.zone
    );

    if (!externalIp) {
      return NextResponse.json(
        { error: "Agent instance not reachable" },
        { status: 503 }
      );
    }

    const url = date
      ? `http://${externalIp}:8080/logs?date=${encodeURIComponent(date)}`
      : `http://${externalIp}:8080/logs`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return NextResponse.json(
        { error: errorData.error || "Failed to fetch logs" },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Error fetching logs:", error);
    return NextResponse.json(
      { error: "Failed to fetch logs" },
      { status: 500 }
    );
  }
}
