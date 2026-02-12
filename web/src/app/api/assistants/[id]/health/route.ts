import { NextResponse } from "next/server";

import { requireAssistantOwner, toAuthErrorResponse } from "@/lib/auth/server-session";
import { createRuntimeClient, RuntimeClientError } from "@/lib/runtime/client";
import { resolveRuntime } from "@/lib/runtime/resolver";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;
    await requireAssistantOwner(request, assistantId);

    const { baseUrl, mode } = resolveRuntime(assistantId);
    const client = createRuntimeClient(baseUrl, assistantId);

    const healthData = await client.health();

    return NextResponse.json({
      ...healthData,
      connectionMode: mode,
    });
  } catch (error: unknown) {
    if (error instanceof RuntimeClientError) {
      console.error("Error checking assistant health:", error);
      return NextResponse.json(
        {
          status: "unhealthy",
          message: `Runtime health check returned ${error.status}`,
        },
        { status: error.httpStatus },
      );
    }
    if (error instanceof Error && ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"].includes(error.message)) {
      return toAuthErrorResponse(error);
    }
    console.error("Error checking assistant health:", error);

    return NextResponse.json(
      {
        status: "unreachable",
        message: error instanceof Error ? error.message : "Failed to check assistant health",
      },
      { status: 502 },
    );
  }
}
