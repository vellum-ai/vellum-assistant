import { NextResponse } from "next/server";

import { requireAssistantOwner, toAuthErrorResponse } from "@/lib/auth/server-session";
import { getAssistantConnectionMode } from "@/lib/assistant-connection";
import { startInstance } from "@/lib/gcp";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;
    const { assistant } = await requireAssistantOwner(request, assistantId);

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
    if (error instanceof Error && ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"].includes(error.message)) {
      return toAuthErrorResponse(error);
    }
    console.error("Error starting assistant:", error);
    return NextResponse.json(
      { error: "Failed to start assistant" },
      { status: 500 }
    );
  }
}
