import { afterEach, describe, expect, mock, test } from "bun:test";

import { client } from "@/generated/daemon/client.gen";
import { ApiError } from "@/utils/api-errors";

import { startMcpAuth } from "./mcp-api";

const originalPost = client.post;

afterEach(() => {
  client.post = originalPost;
});

describe("startMcpAuth", () => {
  test("preserves the daemon error message when authorization cannot start", async () => {
    client.post = mock(async () => ({
      data: undefined,
      error: {
        error: {
          message: "OAuth client registration failed: invalid_redirect_uri",
        },
      },
      response: new Response(null, { status: 500 }),
    })) as typeof client.post;

    const error = await startMcpAuth("assistant-1", "intercom").catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 500,
      message: "OAuth client registration failed: invalid_redirect_uri",
    });
  });
});
