import { NextResponse } from "next/server";

import { Agent, getDb } from "@/lib/db";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const sql = getDb();
    const { id } = await params;

    const result = await sql`SELECT * FROM agents WHERE id = ${id}`;

    if (result.length === 0) {
      return NextResponse.json(
        { error: "Agent not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(result[0] as Agent);
  } catch (error) {
    console.error("Error fetching agent:", error);
    return NextResponse.json(
      { error: "Failed to fetch agent" },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const sql = getDb();
    const { id } = await params;
    const body: UpdateAgentInput = await request.json();

    const result = await sql`
      UPDATE agents
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
        { error: "Agent not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(result[0] as Agent);
  } catch (error) {
    console.error("Error updating agent:", error);
    return NextResponse.json(
      { error: "Failed to update agent" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const sql = getDb();
    const { id } = await params;

    const result = await sql`DELETE FROM agents WHERE id = ${id} RETURNING id`;

    if (result.length === 0) {
      return NextResponse.json(
        { error: "Agent not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting agent:", error);
    return NextResponse.json(
      { error: "Failed to delete agent" },
      { status: 500 }
    );
  }
}
