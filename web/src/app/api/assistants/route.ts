import { NextResponse } from "next/server";

import { Assistant, CreateAssistantInput, getDb } from "@/lib/db";
import {
  getDefaultEditorTemplate,
  uploadEditorPage,
} from "@/lib/gcp";
import { createAssistantToken } from "@/lib/auth/assistant-tokens";
import { getRequestUser } from "@/lib/auth/server-session";

export async function GET(request: Request) {
  try {
    const user = await getRequestUser(request);
    if (!user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const sql = getDb();
    const identifiers = [user.id, user.username].filter(Boolean);
    const assistants = await sql`SELECT * FROM assistants WHERE created_by = ANY(${identifiers}) ORDER BY created_at DESC`;
    return NextResponse.json(assistants as unknown as Assistant[]);
  } catch (error: unknown) {
    console.error("Error fetching assistants:", error);
    return NextResponse.json(
      { error: "Failed to fetch assistants" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const encoder = new TextEncoder();

  function sseEvent(event: string, data: Record<string, unknown>): Uint8Array {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const user = await getRequestUser(request);
  if (!user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body: CreateAssistantInput = await request.json();
  const createdBy = user.id;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const sql = getDb();

        if (!body.name) {
          body.name = "New Assistant";
        }

        const initialConfig = body.configuration ?? {};

        controller.enqueue(sseEvent("progress", { step: "database", message: "Creating assistant record..." }));
        const result = await sql`
          INSERT INTO assistants (name, description, configuration, created_by)
          VALUES (${body.name}, ${body.description || null}, ${JSON.stringify(initialConfig)}, ${createdBy})
          RETURNING *
        `;
        const assistant = result[0] as Assistant;

        const { plaintext: assistantToken } = await createAssistantToken(assistant.id);
        controller.enqueue(sseEvent("token", { token: assistantToken }));

        controller.enqueue(sseEvent("progress", { step: "editor", message: "Setting up editor..." }));
        try {
          const editorTemplate = getDefaultEditorTemplate();
          await uploadEditorPage(assistant.id, editorTemplate);
        } catch (editorError) {
          console.error("Editor page upload failed (continuing anyway):", editorError);
        }

        // TODO(Team Apollo): Re-enable compute assistant creation
        // try {
        //   const { bucket, prefix } = await uploadAssistantToGCS(assistant.id, assistant.name, { apiKey });
        //
        //   controller.enqueue(sseEvent("progress", {
        //     step: "compute",
        //     message: "Provisioning compute instance..."
        //   }));
        //
        //   const { instanceName, zone, machineType } = await createAssistantComputeInstance(
        //     assistant.id,
        //     assistant.name,
        //     bucket,
        //     prefix
        //   );
        //
        //   await sql`
        //     UPDATE assistants
        //     SET configuration = ${JSON.stringify({
        //       ...(assistant.configuration as Record<string, unknown> || {}),
        //       gcs: { bucket, prefix },
        //       compute: { instanceName, zone, machineType },
        //     })}
        //     WHERE id = ${assistant.id}
        //   `;
        // } catch (gcpError) {
        //   console.error("GCP operations failed (continuing anyway):", gcpError);
        //   const errorMessage = gcpError instanceof Error ? gcpError.message : "Unknown GCP error";
        //   await sql`
        //     UPDATE assistants
        //     SET configuration = ${JSON.stringify({
        //       ...(assistant.configuration as Record<string, unknown> || {}),
        //       provisioningError: errorMessage,
        //     })}
        //     WHERE id = ${assistant.id}
        //   `;
        // }

        // Note: Email setup is now delayed - assistant can call POST /api/assistants/{id}/setup-email
        // when it's ready to set up its own email inbox

        const updatedResult = await sql`SELECT * FROM assistants WHERE id = ${assistant.id}`;
        controller.enqueue(sseEvent("complete", { assistant: updatedResult[0] }));
        controller.close();
      } catch (error: unknown) {
        console.error("Error creating assistant:", error);
        const errorMessage = error instanceof Error ? error.message : "Failed to create assistant";
        controller.enqueue(sseEvent("error", { message: errorMessage }));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
