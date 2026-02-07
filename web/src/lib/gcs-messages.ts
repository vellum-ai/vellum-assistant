import { Storage } from "@google-cloud/storage";

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "vellum-nonprod";
const GCP_SA_KEY = process.env.GCP_SA_KEY;

function getGcpCredentials(): { projectId: string; credentials?: object } {
  const config: { projectId: string; credentials?: object } = {
    projectId: GCP_PROJECT_ID,
  };
  if (GCP_SA_KEY) {
    config.credentials = JSON.parse(GCP_SA_KEY);
  }
  return config;
}

function getStorage(): Storage {
  return new Storage(getGcpCredentials());
}

export interface Message {
  id: string;
  content: string;
  status: "unread" | "read" | "queued" | "sent";
  createdAt: string;
  sender: "user" | "agent";
  processedAt?: string;
}

export async function uploadMessageToGCS(
  bucketName: string,
  prefix: string,
  messageId: string,
  message: Message
): Promise<void> {
  const storage = getStorage();
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(`${prefix}/${messageId}.json`);

  await file.save(JSON.stringify(message, null, 2), {
    contentType: "application/json",
    metadata: {
      messageId,
      status: message.status,
      createdAt: message.createdAt,
    },
  });
}

export async function getMessagesFromGCS(
  bucketName: string,
  prefix: string
): Promise<Message[]> {
  const storage = getStorage();
  const bucket = storage.bucket(bucketName);

  const [files] = await bucket.getFiles({ prefix });

  const messages: Message[] = [];

  for (const file of files) {
    if (file.name.endsWith(".json")) {
      try {
        const [content] = await file.download();
        const message = JSON.parse(content.toString()) as Message;
        messages.push(message);
      } catch (error) {
        console.error(`Failed to parse message file ${file.name}:`, error);
      }
    }
  }

  return messages.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

export async function getUnreadMessagesFromGCS(
  bucketName: string,
  prefix: string
): Promise<Message[]> {
  const messages = await getMessagesFromGCS(bucketName, prefix);
  return messages.filter((m) => m.status === "unread");
}

export async function updateMessageStatus(
  bucketName: string,
  prefix: string,
  messageId: string,
  status: Message["status"]
): Promise<void> {
  const storage = getStorage();
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(`${prefix}/${messageId}.json`);

  try {
    const [content] = await file.download();
    const message = JSON.parse(content.toString()) as Message;
    message.status = status;
    if (status === "read" || status === "sent") {
      message.processedAt = new Date().toISOString();
    }

    await file.save(JSON.stringify(message, null, 2), {
      contentType: "application/json",
      metadata: {
        messageId,
        status: message.status,
        createdAt: message.createdAt,
      },
    });
  } catch (error) {
    console.error(`Failed to update message status for ${messageId}:`, error);
    throw error;
  }
}
