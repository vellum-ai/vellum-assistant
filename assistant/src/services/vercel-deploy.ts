/**
 * Thin wrapper around the Vercel REST API for deploying static HTML pages.
 */

import { ProviderError } from "../util/errors.js";

export async function deployHtmlToVercel(opts: {
  html: string;
  name: string;
  token: string;
}): Promise<{ url: string; deploymentId: string }> {
  const slug = opts.name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const body = {
    name: slug,
    files: [
      {
        file: "index.html",
        data: Buffer.from(opts.html).toString("base64"),
        encoding: "base64",
      },
    ],
    projectSettings: { framework: null },
    target: "production",
  };

  const response = await fetch("https://api.vercel.com/v13/deployments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new ProviderError(
      `Vercel deploy failed (${response.status}): ${text}`,
      "vercel",
      response.status,
    );
  }

  const data = (await response.json()) as { url: string; id: string };

  let publicUrl = data.url;
  if (!publicUrl.startsWith("https://")) {
    publicUrl = `https://${publicUrl}`;
  }

  return { url: publicUrl, deploymentId: data.id };
}
