import { NextResponse } from "next/server";

import { Assistant, getDb, UpdateAssistantInput } from "@/lib/db";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const sql = getDb();
    const { id } = await params;

    const result = await sql`SELECT * FROM assistants WHERE id = ${id}`;

    if (result.length === 0) {
      return NextResponse.json(
        { error: "Assistant not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(result[0] as Assistant);
  } catch (error) {
    console.error("Error fetching assistant:", error);
    return NextResponse.json(
      { error: "Failed to fetch assistant" },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const sql = getDb();
    const { id } = await params;
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
    return NextResponse.json(
      { error: "Failed to update assistant" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const sql = getDb();
    const { id } = await params;

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
    return NextResponse.json(
      { error: "Failed to delete assistant" },
      { status: 500 }
    );
  }
}
