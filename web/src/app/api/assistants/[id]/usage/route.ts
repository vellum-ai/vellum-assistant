import { NextRequest, NextResponse } from "next/server";

import { requireAssistantOwner, toAuthErrorResponse } from "@/lib/auth/server-session";
import { createRuntimeClient, RuntimeClientError } from "@/lib/runtime/client";
import { resolveRuntime } from "@/lib/runtime/resolver";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;
    await requireAssistantOwner(request, assistantId);

    const { baseUrl } = resolveRuntime(assistantId);
    const client = createRuntimeClient(baseUrl, assistantId);

    const preset = request.nextUrl.searchParams.get("preset") ?? undefined;
    const startParam = request.nextUrl.searchParams.get("start");
    const endParam = request.nextUrl.searchParams.get("end");

    const result = await client.getUsage({
      preset: preset as "24h" | "7d" | "30d" | undefined,
      start: startParam != null ? Number(startParam) : undefined,
      end: endParam != null ? Number(endParam) : undefined,
    });

    return NextResponse.json(result);
  } catch (error: unknown) {
    if (error instanceof RuntimeClientError) {
      return NextResponse.json(
        { error: "Failed to fetch usage" },
        { status: error.httpStatus },
      );
    }
    if (error instanceof Error && ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"].includes(error.message)) {
      return toAuthErrorResponse(error);
    }
    console.error("Error fetching usage:", error);
    return NextResponse.json(
      { error: "Failed to fetch usage" },
      { status: 500 },
    );
  }
}
