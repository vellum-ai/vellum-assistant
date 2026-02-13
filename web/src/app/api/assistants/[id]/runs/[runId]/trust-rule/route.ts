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

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId, runId } = await params;

    const assistant = await getAssistantById(assistantId);
    if (!assistant) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const body = await request.json() as {
      toolName?: unknown;
      pattern?: unknown;
      scope?: unknown;
      decision?: unknown;
    };

    const { toolName, pattern, scope, decision } = body;

    if (!toolName || typeof toolName !== "string") {
      return NextResponse.json({ error: "toolName is required" }, { status: 400 });
    }
    if (!pattern || typeof pattern !== "string") {
      return NextResponse.json({ error: "pattern is required" }, { status: 400 });
    }
    if (!scope || typeof scope !== "string") {
      return NextResponse.json({ error: "scope is required" }, { status: 400 });
    }
    if (decision !== "allow" && decision !== "deny") {
      return NextResponse.json(
        { error: "decision must be \"allow\" or \"deny\"" },
        { status: 400 },
      );
    }

    const client = getRuntimeClient(assistantId);
    const result = await client.addTrustRule(runId, {
      toolName,
      pattern,
      scope,
      decision,
    });

    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("Error adding trust rule:", error);
    const status = error instanceof RuntimeClientError ? error.httpStatus : 500;
    return NextResponse.json(
      { error: "Failed to add trust rule" },
      { status },
    );
  }
}
