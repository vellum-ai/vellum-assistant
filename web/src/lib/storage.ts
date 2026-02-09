import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Storage as GCSStorage } from "@google-cloud/storage";

import { GCP_PROJECT_ID } from "@/lib/gcp-config";

const NODE_ENV = process.env.NODE_ENV || "development";

function isLocalDev(): boolean {
  return NODE_ENV !== "production";
}

export interface StorageFile {
  name: string;
  save(
    content: string | Buffer,
    options?: { contentType?: string; metadata?: Record<string, string> }
  ): Promise<void>;
  download(): Promise<[Buffer]>;
  exists(): Promise<[boolean]>;
}

export interface StorageBucket {
  file(path: string): StorageFile;
  getFiles(options: { prefix: string }): Promise<[StorageFile[]]>;
}

export interface Storage {
  bucket(name: string): StorageBucket;
}

// S3/MinIO implementation

function createS3Storage(): Storage {
  const endpoint = process.env.MINIO_ENDPOINT || "http://localhost:9000";
  const accessKey = process.env.MINIO_ACCESS_KEY || "minioadmin";
  const secretKey = process.env.MINIO_SECRET_KEY || "minioadmin";

  const client = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
  });

  return {
    bucket(bucketName: string): StorageBucket {
      return {
        file(key: string): StorageFile {
          return {
            name: key,
            async save(content, options) {
              await client.send(
                new PutObjectCommand({
                  Bucket: bucketName,
                  Key: key,
                  Body: typeof content === "string" ? content : content,
                  ContentType: options?.contentType,
                  Metadata: options?.metadata,
                })
              );
            },
            async download() {
              const resp = await client.send(
                new GetObjectCommand({ Bucket: bucketName, Key: key })
              );
              const bytes = await resp.Body!.transformToByteArray();
              return [Buffer.from(bytes)];
            },
            async exists() {
              try {
                await client.send(
                  new HeadObjectCommand({ Bucket: bucketName, Key: key })
                );
                return [true];
              } catch {
                return [false];
              }
            },
          };
        },
        async getFiles(options) {
          const resp = await client.send(
            new ListObjectsV2Command({
              Bucket: bucketName,
              Prefix: options.prefix,
            })
          );
          const files = (resp.Contents || []).map((obj) => {
            const key = obj.Key!;
            return this.file(key);
          });
          return [files];
        },
      };
    },
  };
}

// GCS implementation (wraps @google-cloud/storage to match our interface)

function createGCSStorage(): Storage {
  const gcs = new GCSStorage({ projectId: GCP_PROJECT_ID });

  return {
    bucket(bucketName: string): StorageBucket {
      const gcsBucket = gcs.bucket(bucketName);
      return {
        file(path: string): StorageFile {
          const gcsFile = gcsBucket.file(path);
          return {
            name: path,
            async save(content, options) {
              await gcsFile.save(content, {
                contentType: options?.contentType,
                metadata: options?.metadata,
              });
            },
            async download() {
              const [content] = await gcsFile.download();
              return [content];
            },
            async exists() {
              return gcsFile.exists();
            },
          };
        },
        async getFiles(options) {
          const [gcsFiles] = await gcsBucket.getFiles({ prefix: options.prefix });
          const files = gcsFiles.map((gf) => {
            const f: StorageFile = {
              name: gf.name,
              async save(content, opts) {
                await gf.save(content, {
                  contentType: opts?.contentType,
                  metadata: opts?.metadata,
                });
              },
              async download() {
                const [content] = await gf.download();
                return [content];
              },
              async exists() {
                return gf.exists();
              },
            };
            return f;
          });
          return [files];
        },
      };
    },
  };
}

export function getStorage(): Storage {
  if (isLocalDev()) {
    return createS3Storage();
  }
  return createGCSStorage();
}
