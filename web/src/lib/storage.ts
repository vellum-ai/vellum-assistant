import { Storage } from "@google-cloud/storage";

import { GCP_PROJECT_ID } from "@/lib/gcp-config";

const NODE_ENV = process.env.NODE_ENV || "development";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "http://localhost:9000";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "minioadmin";

function isLocalDev(): boolean {
  return NODE_ENV !== "production";
}

export function getStorage(): Storage {
  if (isLocalDev()) {
    return new Storage({
      projectId: "local",
      apiEndpoint: MINIO_ENDPOINT,
      credentials: {
        client_email: MINIO_ACCESS_KEY,
        private_key: MINIO_SECRET_KEY,
      },
    });
  }

  return new Storage({ projectId: GCP_PROJECT_ID });
}
