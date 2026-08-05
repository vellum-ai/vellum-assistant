#!/usr/bin/env bun

import { createReadStream } from "node:fs";
import { parseArgs } from "node:util";

import * as androidpublisher from "@googleapis/androidpublisher";

const ANDROID_PUBLISHER_SCOPE =
  "https://www.googleapis.com/auth/androidpublisher";
const INTERNAL_TRACK = "internal";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    bundle: { type: "string" },
    "package-id": { type: "string" },
    "release-name": { type: "string" },
  },
  strict: true,
});

void main().catch((error: unknown) => {
  console.error(`Google Play publishing failed: ${errorMessage(error)}`);
  process.exit(1);
});

async function main(): Promise<void> {
  const bundlePath = requireArgument("bundle", values.bundle);
  const packageId = requireArgument("package-id", values["package-id"]);
  const releaseName = requireArgument("release-name", values["release-name"]);

  const auth = new androidpublisher.auth.GoogleAuth({
    scopes: [ANDROID_PUBLISHER_SCOPE],
  });
  const publisher = androidpublisher.androidpublisher({
    version: "v3",
    auth,
  });
  const edit = await publisher.edits.insert({
    packageName: packageId,
    requestBody: {},
  });
  const editId = edit.data.id;

  if (!editId) {
    throw new Error("Google Play created an edit without an ID");
  }

  try {
    const uploadedBundle = await publisher.edits.bundles.upload(
      {
        packageName: packageId,
        editId,
        media: {
          mimeType: "application/octet-stream",
          body: createReadStream(bundlePath),
        },
      },
      { timeout: 600_000 }
    );
    const versionCode = uploadedBundle.data.versionCode;

    if (!versionCode || versionCode < 1) {
      throw new Error("Google Play returned an invalid bundle version code");
    }

    await publisher.edits.tracks.update({
      packageName: packageId,
      editId,
      track: INTERNAL_TRACK,
      requestBody: {
        track: INTERNAL_TRACK,
        releases: [
          {
            name: releaseName,
            status: "completed",
            versionCodes: [String(versionCode)],
          },
        ],
      },
    });
    await publisher.edits.commit({
      packageName: packageId,
      editId,
      changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
    });

    console.log(
      `Published ${packageId} version code ${versionCode} to the Google Play ${INTERNAL_TRACK} track`
    );
  } catch (error) {
    await deleteEdit(publisher, packageId, editId);
    throw error;
  }
}

function requireArgument(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`--${name} is required`);
  }

  return value;
}

async function deleteEdit(
  publisher: ReturnType<typeof androidpublisher.androidpublisher>,
  packageId: string,
  editId: string
): Promise<void> {
  try {
    await publisher.edits.delete({
      packageName: packageId,
      editId,
    });
  } catch (error) {
    console.warn(
      `Failed to delete the uncommitted Google Play edit: ${errorMessage(error)}`
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
