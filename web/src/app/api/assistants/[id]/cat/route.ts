import { NextRequest, NextResponse } from "next/server";

import { requireAssistantOwner, toAuthErrorResponse } from "@/lib/auth/server-session";
import { getAssistantConnectionMode } from "@/lib/assistant-connection";
import { getInstanceExternalIp } from "@/lib/gcp";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

function obfuscateEnvContent(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      if (line.trim().startsWith("#") || !line.trim()) {
        return line;
      }
      const eqIndex = line.indexOf("=");
      if (eqIndex !== -1) {
        const key = line.substring(0, eqIndex + 1);
        const value = line.substring(eqIndex + 1);
        if (value.length > 6) {
          return `${key}${value.substring(0, 3)}${"*".repeat(Math.min(value.length - 3, 20))}`;
        } else if (value.length > 0) {
          return `${key}${"*".repeat(value.length)}`;
        }
      }
      return line;
    })
    .join("\n");
}

async function fetchFileContentFromAgentServer(
  externalIp: string,
  path: string
): Promise<{ path: string; content: string }> {
  const response = await fetch(
    `http://${externalIp}:8080/cat?path=${encodeURIComponent(path)}`,
    {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      JSON.stringify({ status: response.status, body: errorBody })
    );
  }

  const data = await response.json();

  const filename = path.split("/").pop() || "";
  if (filename === ".env" || filename.endsWith(".env")) {
    data.content = obfuscateEnvContent(data.content);
  }

  return data;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: assistantId } = await params;
    const searchParams = request.nextUrl.searchParams;
    const filePath = searchParams.get("path");

    if (!filePath) {
      return NextResponse.json(
        { error: "Missing 'path' query parameter" },
        { status: 400 }
      );
    }

    const { assistant } = await requireAssistantOwner(request, assistantId);

    if (getAssistantConnectionMode() === "local") {
      return NextResponse.json(
        {
          error:
            "File reads are not supported in local-daemon mode in this rollout (chat + health only).",
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

    const fileData = await fetchFileContentFromAgentServer(externalIp, filePath);
    return NextResponse.json(fileData);
  } catch (error) {
    if (error instanceof Error && ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"].includes(error.message)) {
      return toAuthErrorResponse(error);
    }
    console.error("Error reading file:", error);
    try {
      const parsed = JSON.parse((error as Error).message);
      return NextResponse.json(
        { error: parsed.body },
        { status: parsed.status }
      );
    } catch {
      return NextResponse.json(
        { error: "Failed to read file" },
        { status: 500 }
      );
    }
  }
}
