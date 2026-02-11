import { NextResponse } from "next/server";

import { getAssistantById } from "@/lib/db";
import { createRuntimeClient, RuntimeClientError } from "@/lib/runtime/client";
import { resolveRuntime } from "@/lib/runtime/resolver";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;

    const assistant = await getAssistantById(assistantId);
    if (!assistant) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const { baseUrl, mode } = resolveRuntime(assistantId);
    const client = createRuntimeClient(baseUrl, assistantId);

    const healthData = await client.health();

    return NextResponse.json({
      ...healthData,
      connectionMode: mode,
    });
  } catch (error: unknown) {
    console.error("Error checking assistant health:", error);

    if (error instanceof RuntimeClientError) {
      return NextResponse.json(
        {
          status: "unhealthy",
          message: `Runtime health check returned ${error.status}`,
        },
        { status: error.status },
      );
    }

    return NextResponse.json(
      {
        status: "unreachable",
        message: error instanceof Error ? error.message : "Failed to check assistant health",
      },
      { status: 502 },
    );
  }
}
