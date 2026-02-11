import { NextResponse } from "next/server";

import { requireAssistantOwner, toAuthErrorResponse } from "@/lib/auth/server-session";
import { Assistant, getDb, UpdateAssistantInput } from "@/lib/db";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { assistant } = await requireAssistantOwner(request, id);

    return NextResponse.json(assistant as Assistant);
  } catch (error) {
    console.error("Error fetching assistant:", error);
    return toAuthErrorResponse(error);
  }
}

export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    await requireAssistantOwner(request, id);

    const sql = getDb();
    const body: UpdateAssistantInput = await request.json();

    const result = await sql`
      UPDATE assistants
      SET
        name = COALESCE(${body.name || null}, name),
        description = COALESCE(${body.description || null}, description),
        configuration = COALESCE(${body.configuration ? JSON.stringify(body.configuration) : null}::jsonb, configuration),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;

    if (result.length === 0) {
      return NextResponse.json(
        { error: "Assistant not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(result[0] as Assistant);
  } catch (error) {
    console.error("Error updating assistant:", error);
    return toAuthErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    await requireAssistantOwner(request, id);

    const sql = getDb();
    const result = await sql`DELETE FROM assistants WHERE id = ${id} RETURNING id`;

    if (result.length === 0) {
      return NextResponse.json(
        { error: "Assistant not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting assistant:", error);
    return toAuthErrorResponse(error);
  }
}
