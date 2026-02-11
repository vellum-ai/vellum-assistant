import { NextRequest, NextResponse } from "next/server";

import { getAssistantById } from "@/lib/db";
import { createRuntimeClient, RuntimeClientError } from "@/lib/runtime/client";
import { resolveRuntime } from "@/lib/runtime/resolver";

interface RouteParams {
  params: Promise<{ id: string; runId: string }>;
}

export const runtime = "nodejs";

function getRuntimeClient(assistantId: string) {
  const { baseUrl } = resolveRuntime(assistantId);
  return createRuntimeClient(baseUrl, assistantId);
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId, runId } = await params;

    const assistant = await getAssistantById(assistantId);
    if (!assistant) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const client = getRuntimeClient(assistantId);
    const result = await client.getRun(runId);

    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("Error fetching run:", error);
    const status = error instanceof RuntimeClientError ? error.status : 500;
    return NextResponse.json(
      { error: "Failed to fetch run" },
      { status },
    );
  }
}
