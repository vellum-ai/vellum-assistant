import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "crypto";
import { NextResponse } from "next/server";

import { Agent, CreateAgentInput, getDb } from "@/lib/db";
import {
  createAgentComputeInstance,
  getAvailablePrequeuedInstance,
  getDefaultEditorTemplate,
  uploadAgentConfigToGCS,
  uploadAgentToGCS,
  uploadEditorPage,
} from "@/lib/gcp";

const ADJECTIVES = [
  "Brave", "Clever", "Cosmic", "Crystal", "Dapper", "Fizzy", "Gentle",
  "Golden", "Happy", "Iron", "Jolly", "Lunar", "Mighty", "Noble", "Pixel",
  "Quantum", "Rusty", "Silver", "Sunny", "Turbo", "Velvet", "Witty", "Zesty",
];

const NOUNS = [
  "Badger", "Comet", "Dragon", "Falcon", "Gizmo", "Heron", "Jester",
  "Kitten", "Lemur", "Mango", "Nimbus", "Otter", "Pebble", "Quokka",
  "Raven", "Spark", "Tiger", "Unicorn", "Vortex", "Waffle", "Ziggy",
];

function generateRandomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj} ${noun}`;
}

/**
 * Generate a secure API key for agent authentication
 */
function generateApiKey(): string {
  return `vellum_${randomBytes(32).toString("hex")}`;
}

async function generateAgentName(): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return generateRandomName();
  }

  try {
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 30,
      messages: [
        {
          role: "user",
          content:
            "Generate a single cute, caricature-y name for an AI agent (like 'Sparky', 'Professor Wobble', 'Captain Crunch', 'Pixel Pete'). Reply with ONLY the name, nothing else.",
        },
      ],
    });

    const content = response.content[0];
    if (content.type === "text") {
      return content.text.trim().replace(/^["']|["']$/g, "");
    }
  } catch (error: unknown) {
    console.error("Failed to generate agent name:", error);
    throw error;
  }

  return generateRandomName();
}

export async function GET() {
  try {
    const sql = getDb();
    const assistants = await sql`SELECT * FROM assistants ORDER BY created_at DESC`;
    return NextResponse.json(assistants as unknown as Agent[]);
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

  const body: CreateAgentInput = await request.json();
  const createdBy = request.headers.get("x-username") || null;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const sql = getDb();

        controller.enqueue(sseEvent("progress", { step: "naming", message: "Generating agent name..." }));
        if (!body.name) {
          body.name = await generateAgentName();
        }

        const apiKey = generateApiKey();
        
        const initialConfig = { 
          ...body.configuration, 
          apiKey,
        };

        controller.enqueue(sseEvent("progress", { step: "database", message: "Creating agent record..." }));
        const result = await sql`
          INSERT INTO assistants (name, description, configuration, created_by)
          VALUES (${body.name}, ${body.description || null}, ${JSON.stringify(initialConfig)}, ${createdBy})
          RETURNING *
        `;
        const agent = result[0] as Agent;

        controller.enqueue(sseEvent("progress", { step: "editor", message: "Setting up editor..." }));
        try {
          const editorTemplate = getDefaultEditorTemplate();
          await uploadEditorPage(agent.id, editorTemplate);
        } catch (editorError) {
          console.error("Editor page upload failed (continuing anyway):", editorError);
        }

        try {
          // Check if a prequeued instance is available first
          const prequeued = await getAvailablePrequeuedInstance();
          
          let bucket: string;
          let prefix: string;
          
          if (prequeued) {
            controller.enqueue(sseEvent("progress", { step: "upload", message: "Uploading agent config..." }));
            ({ bucket, prefix } = await uploadAgentConfigToGCS(agent.id, agent.name, { apiKey }));
          } else {
            controller.enqueue(sseEvent("progress", { step: "upload", message: "Uploading agent files..." }));
            ({ bucket, prefix } = await uploadAgentToGCS(agent.id, agent.name, { apiKey }));
          }

          controller.enqueue(sseEvent("progress", { 
            step: "compute", 
            message: prequeued ? "Activating prequeued instance... ⚡" : "Provisioning compute instance..." 
          }));

          const { instanceName, zone, machineType, fromPrequeue } = await createAgentComputeInstance(
            agent.id,
            agent.name,
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
              ...(agent.configuration as Record<string, unknown> || {}),
              gcs: { bucket, prefix },
              compute: { instanceName, zone, machineType, fromPrequeue },
            })}
            WHERE id = ${agent.id}
          `;
        } catch (gcpError) {
          console.error("GCP operations failed (continuing anyway):", gcpError);
          const errorMessage = gcpError instanceof Error ? gcpError.message : "Unknown GCP error";
          await sql`
            UPDATE assistants
            SET configuration = ${JSON.stringify({
              ...(agent.configuration as Record<string, unknown> || {}),
              provisioningError: errorMessage,
            })}
            WHERE id = ${agent.id}
          `;
        }

        // Note: Email setup is now delayed - agent can call POST /api/assistants/{id}/setup-email
        // when it's ready to set up its own email inbox

        const updatedResult = await sql`SELECT * FROM assistants WHERE id = ${agent.id}`;
        controller.enqueue(sseEvent("complete", { agent: updatedResult[0] }));
        controller.close();
      } catch (error: unknown) {
        console.error("Error creating agent:", error);
        const errorMessage = error instanceof Error ? error.message : "Failed to create agent";
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
