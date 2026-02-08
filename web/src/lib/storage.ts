import { Storage } from "@google-cloud/storage";

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "vellum-ai-prod";
const GCP_SA_KEY = process.env.GCP_SA_KEY;
const NODE_ENV = process.env.NODE_ENV || "development";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "http://localhost:9000";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "minioadmin";

function isLocalDev(): boolean {
  return NODE_ENV !== "production";
}

function getGcpCredentials(): { projectId: string; credentials?: object } {
  const config: { projectId: string; credentials?: object } = {
    projectId: GCP_PROJECT_ID,
  };
  if (GCP_SA_KEY) {
    config.credentials = JSON.parse(GCP_SA_KEY);
  }
  return config;
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

  return new Storage(getGcpCredentials());
}
