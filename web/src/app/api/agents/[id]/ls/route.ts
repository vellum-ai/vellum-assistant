import { NextRequest, NextResponse } from "next/server";

import { Agent, getDb } from "@/lib/db";
import { getInstanceExternalIp } from "@/lib/gcp";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface FileEntry {
  name: string;
  type: "file" | "directory";
}

async function fetchFilesFromAgentServer(
  externalIp: string,
  path: string
): Promise<FileEntry[]> {
  const response = await fetch(
    `http://${externalIp}:8080/ls?path=${encodeURIComponent(path)}`,
    {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    }
  );

  if (!response.ok) {
    throw new Error(`Agent returned ${response.status}`);
  }

  const data = await response.json();
  return data.files as FileEntry[];
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: agentId } = await params;
    const searchParams = request.nextUrl.searchParams;
    const path = searchParams.get("path") || "/opt/velly-agent";

    const sql = getDb();
    const result = await sql`SELECT * FROM agents WHERE id = ${agentId}`;

    if (result.length === 0) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const agent = result[0] as Agent;
    const computeConfig = (agent.configuration as Record<string, any>)?.compute as
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

    const files = await fetchFilesFromAgentServer(externalIp, path);
    return NextResponse.json({ files, path });
  } catch (error: unknown) {
    console.error("Error listing files:", error);
    return NextResponse.json(
      { error: "Failed to list files" },
      { status: 500 }
    );
  }
}
