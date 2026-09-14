import { beforeEach, describe, expect, mock, test } from "bun:test";

// The route is a thin door over the channel-file function: it names the
// file by path, maps the function's refusals onto route errors, and hands
// the bytes back in the base64 envelope the CLI knows how to write.

const downloadCalls: Array<Record<string, unknown>> = [];
let downloadImpl: (params: Record<string, unknown>) => Promise<unknown>;

const actualChannelFile = await import("../../channel-file.js");
mock.module("../../channel-file.js", () => ({
  ...actualChannelFile,
  downloadChannelFile: async (params: Record<string, unknown>) => {
    downloadCalls.push(params);
    return downloadImpl(params);
  },
}));

const { ChannelFileNotSupportedError } = actualChannelFile;
const { ChannelFileTooLargeError, ChannelFileUnavailableError } =
  await import("../../../messaging/providers/channel-transport.js");
const { ROUTES } = await import("../channel-file-routes.js");
const { BadGatewayError, BadRequestError, PayloadTooLargeError } =
  await import("../errors.js");

const route = ROUTES.find((r) => r.operationId === "channels_file_get")!;

beforeEach(() => {
  downloadCalls.length = 0;
  downloadImpl = async (params) => ({
    channel: params.channel,
    fileId: params.fileId,
    filename: "shot.png",
    mimeType: "image/png",
    data: Buffer.from([1, 2, 3]).toString("base64"),
    size: 3,
  });
});

describe("GET channels/:channel/files/:fileId", () => {
  test("is registered as a chat read for actor principals", () => {
    expect(route).toBeDefined();
    expect(route.endpoint).toBe("channels/:channel/files/:fileId");
    expect(route.method).toBe("GET");
    expect(route.policy?.requiredScopes).toEqual(["chat.read"]);
  });

  test("hands the path's channel and file id to the function and returns the envelope", async () => {
    const result = await route.handler({
      pathParams: { channel: "slack", fileId: "F1" },
      queryParams: { account: "T123" },
    });
    expect(downloadCalls).toEqual([
      { channel: "slack", fileId: "F1", account: "T123" },
    ]);
    expect(result).toEqual({
      channel: "slack",
      fileId: "F1",
      filename: "shot.png",
      mimeType: "image/png",
      size: 3,
      body: Buffer.from([1, 2, 3]).toString("base64"),
      bodyEncoding: "base64",
    });
  });

  test("refuses a missing channel or file id before calling anything", async () => {
    await expect(
      route.handler({ pathParams: { channel: "slack" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(downloadCalls).toHaveLength(0);
  });

  test("a channel without the capability is a bad request naming the ones that have it", async () => {
    downloadImpl = async () => {
      throw new ChannelFileNotSupportedError(
        'Channel "discord" cannot fetch a file by id. Channels that can: slack.',
      );
    };
    await expect(
      route.handler({ pathParams: { channel: "discord", fileId: "F1" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("a file over the cap is payload too large", async () => {
    downloadImpl = async () => {
      throw new ChannelFileTooLargeError("too big");
    };
    await expect(
      route.handler({ pathParams: { channel: "slack", fileId: "F1" } }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  test("a file the channel cannot hand back is a bad gateway", async () => {
    downloadImpl = async () => {
      throw new ChannelFileUnavailableError("no such file");
    };
    await expect(
      route.handler({ pathParams: { channel: "slack", fileId: "F1" } }),
    ).rejects.toBeInstanceOf(BadGatewayError);
  });
});
