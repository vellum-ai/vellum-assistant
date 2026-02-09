import { randomBytes } from "crypto";
import { NextResponse } from "next/server";

import { Assistant, CreateAssistantInput, getDb } from "@/lib/db";
import {
  createAssistantComputeInstance,
  getAvailablePrequeuedInstance,
  getDefaultEditorTemplate,
  uploadAssistantConfigToGCS,
  uploadAssistantToGCS,
  uploadEditorPage,
} from "@/lib/gcp";

function generateApiKey(): string {
  return `vellum_${randomBytes(32).toString("hex")}`;
}

export async function GET() {
  try {
    const sql = getDb();
    const assistants = await sql`SELECT * FROM assistants ORDER BY created_at DESC`;
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

  const body: CreateAssistantInput = await request.json();
  const createdBy = request.headers.get("x-username") || null;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const sql = getDb();

        if (!body.name) {
          body.name = "New Assistant";
        }

        const apiKey = generateApiKey();
        
        const initialConfig = { 
          ...body.configuration, 
          apiKey,
        };

        controller.enqueue(sseEvent("progress", { step: "database", message: "Creating assistant record..." }));
        const result = await sql`
          INSERT INTO assistants (name, description, configuration, created_by)
          VALUES (${body.name}, ${body.description || null}, ${JSON.stringify(initialConfig)}, ${createdBy})
          RETURNING *
        `;
        const assistant = result[0] as Assistant;

        controller.enqueue(sseEvent("progress", { step: "editor", message: "Setting up editor..." }));
        try {
          const editorTemplate = getDefaultEditorTemplate();
          await uploadEditorPage(assistant.id, editorTemplate);
        } catch (editorError) {
          console.error("Editor page upload failed (continuing anyway):", editorError);
        }

        // Skip GCP provisioning in local dev - no compute instances or agent-templates available
        if (process.env.NODE_ENV === "production") {
          try {
            // Check if a prequeued instance is available first
            const prequeued = await getAvailablePrequeuedInstance();

            let bucket: string;
            let prefix: string;

            if (prequeued) {
              controller.enqueue(sseEvent("progress", { step: "upload", message: "Uploading assistant config..." }));
              ({ bucket, prefix } = await uploadAssistantConfigToGCS(assistant.id, assistant.name, { apiKey }));
            } else {
              controller.enqueue(sseEvent("progress", { step: "upload", message: "Uploading assistant files..." }));
              ({ bucket, prefix } = await uploadAssistantToGCS(assistant.id, assistant.name, { apiKey }));
            }

            controller.enqueue(sseEvent("progress", {
              step: "compute",
              message: prequeued ? "Activating prequeued instance... ⚡" : "Provisioning compute instance..."
            }));

            const { instanceName, zone, machineType, fromPrequeue } = await createAssistantComputeInstance(
              assistant.id,
              assistant.name,
              bucket,
              prefix
            );

            // Report whether we used a prequeued instance
            if (fromPrequeue) {
              controller.enqueue(sseEvent("progress", {
                step: "compute",
                message: "Activated prequeued instance (fast path! ⚡)"
              }));
            }

            await sql`
              UPDATE assistants
              SET configuration = ${JSON.stringify({
                ...(assistant.configuration as Record<string, unknown> || {}),
                gcs: { bucket, prefix },
                compute: { instanceName, zone, machineType, fromPrequeue },
              })}
              WHERE id = ${assistant.id}
            `;
          } catch (gcpError) {
            console.error("GCP operations failed (continuing anyway):", gcpError);
            const errorMessage = gcpError instanceof Error ? gcpError.message : "Unknown GCP error";
            await sql`
              UPDATE assistants
              SET configuration = ${JSON.stringify({
                ...(assistant.configuration as Record<string, unknown> || {}),
                provisioningError: errorMessage,
              })}
              WHERE id = ${assistant.id}
            `;
          }
        }

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
