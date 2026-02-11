import { NextResponse } from "next/server";

import { requireAssistantOwner, toAuthErrorResponse } from "@/lib/auth/server-session";
import {
  getDefaultEditorTemplate,
  updateEditorPage,
} from "@/lib/gcp";
import { transpileEditorSource } from "@/lib/transpile";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    await requireAssistantOwner(request, id);

    const url = new URL(request.url);
    const format = url.searchParams.get("format");

    const source = getDefaultEditorTemplate();

    if (format === "source") {
      return NextResponse.json({ source });
    }

    const compiled = transpileEditorSource(source);
    return NextResponse.json({ source, compiled });
  } catch (error) {
    if (error instanceof Error && ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"].includes(error.message)) {
      return toAuthErrorResponse(error);
    }
    console.error("Error fetching editor page:", error);
    return NextResponse.json(
      { error: "Failed to fetch editor page" },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    await requireAssistantOwner(request, id);

    const body = await request.json();
    const { source } = body as { source: string };

    if (!source) {
      return NextResponse.json(
        { error: "Source content is required" },
        { status: 400 }
      );
    }

    try {
      transpileEditorSource(source);
    } catch (transpileError) {
      const message =
        transpileError instanceof Error
          ? transpileError.message
          : "Unknown transpilation error";
      return NextResponse.json(
        { error: `Invalid editor source: ${message}` },
        { status: 400 }
      );
    }

    const success = await updateEditorPage(id, source);
    if (!success) {
      return NextResponse.json(
        { error: "Failed to update editor page in storage" },
        { status: 500 }
      );
    }

    const compiled = transpileEditorSource(source);
    return NextResponse.json({ source, compiled });
  } catch (error) {
    if (error instanceof Error && ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"].includes(error.message)) {
      return toAuthErrorResponse(error);
    }
    console.error("Error updating editor page:", error);
    return NextResponse.json(
      { error: "Failed to update editor page" },
      { status: 500 }
    );
  }
}
