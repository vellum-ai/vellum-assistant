import { NextRequest, NextResponse } from "next/server";

import { requireAssistantOwner, toAuthErrorResponse } from "@/lib/auth/server-session";
import { getAssistantConnectionMode } from "@/lib/assistant-connection";
import { getInstanceExternalIp } from "@/lib/gcp";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

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
    const { id: assistantId } = await params;
    const searchParams = request.nextUrl.searchParams;
    const path = searchParams.get("path") || "/opt/vellum-agent";

    const { assistant } = await requireAssistantOwner(request, assistantId);

    if (getAssistantConnectionMode() === "local") {
      return NextResponse.json(
        {
          error:
            "File system browsing is not supported in local-daemon mode in this rollout (chat + health only).",
          connectionMode: "local",
          files: [],
          path,
        },
        { status: 501 }
      );
    }

    const computeConfig = (assistant.configuration as Record<string, unknown>)?.compute as
      | { instanceName?: string; zone?: string }
      | undefined;

    if (!computeConfig?.instanceName || !computeConfig?.zone) {
      if (process.env.NODE_ENV !== "production") {
        return NextResponse.json({
          files: [],
          path,
          demoMode: true,
          message: "File system browsing is unavailable in local demo mode (no compute instance configured).",
        });
      }
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
    if (error instanceof Error && ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"].includes(error.message)) {
      return toAuthErrorResponse(error);
    }
    console.error("Error listing files:", error);
    return NextResponse.json(
      { error: "Failed to list files" },
      { status: 500 }
    );
  }
}
