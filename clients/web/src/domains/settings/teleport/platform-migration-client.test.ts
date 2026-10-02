import { beforeEach, describe, expect, mock, test } from "bun:test";

const postMock = mock(async (_opts: { url: string; body: unknown }) => ({
  data: { url: "https://storage.example.com/download" },
  response: { ok: true, status: 200 },
}));

mock.module("@/generated/api/client.gen", () => ({
  client: { post: postMock },
}));

const { requestSignedDownloadUrl } = await import(
  "./platform-migration-client"
);

beforeEach(() => {
  postMock.mockClear();
});

describe("requestSignedDownloadUrl", () => {
  test("asks for an attachment download under the given filename", async () => {
    const url = await requestSignedDownloadUrl(
      "uploads/org-abc/bundle.vbundle",
      "1.2.3",
      "ast-1-2026-10-02.vbundle",
    );

    expect(url).toBe("https://storage.example.com/download");
    expect(postMock.mock.calls[0]?.[0].body).toEqual({
      operation: "download",
      bundle_key: "uploads/org-abc/bundle.vbundle",
      target_runtime_version: "1.2.3",
      download_filename: "ast-1-2026-10-02.vbundle",
    });
  });

  test("leaves download_filename unset for an in-memory download", async () => {
    await requestSignedDownloadUrl("uploads/org-abc/bundle.vbundle", "1.2.3");

    const body = postMock.mock.calls[0]?.[0].body as Record<string, unknown>;
    expect(body.download_filename).toBeUndefined();
  });
});
