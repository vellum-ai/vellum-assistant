import { beforeEach, describe, expect, mock, test } from "bun:test";

// The by-id fetch composes three things the adapter already owns: the
// file's metadata as the bot, the bot token resolved inside the process,
// and the capped downloader. The tests pin what each is handed and how the
// two ways of coming back empty are reported.

const infoCalls: string[] = [];
const downloadCalls: Array<{
  file: Record<string, unknown>;
  token: string;
  opts: Record<string, unknown>;
}> = [];
let fileInfo: Record<string, unknown> | undefined;
let downloaded: { filename: string; mimeType: string; data: string } | null;
let botToken: string | null = "xoxb-test";

const actualApi = await import("../api.js");
mock.module("../api.js", () => ({
  ...actualApi,
  getSlackFileInfo: async (fileId: string) => {
    infoCalls.push(fileId);
    return fileInfo;
  },
}));

const actualAdapter = await import("../adapter.js");
mock.module("../adapter.js", () => ({
  ...actualAdapter,
  withSlackBotToken: async (
    _account: string | undefined,
    fn: (token: string) => Promise<unknown>,
  ) => (botToken === null ? null : fn(botToken)),
}));

const actualDownload = await import("../download.js");
mock.module("../download.js", () => ({
  ...actualDownload,
  downloadSlackFile: async (
    file: Record<string, unknown>,
    token: string,
    opts: Record<string, unknown>,
  ) => {
    downloadCalls.push({ file, token, opts });
    return downloaded;
  },
}));

const { downloadSlackFileById } = await import("../file.js");
const { ChannelFileUnavailableError } =
  await import("../../channel-transport.js");

beforeEach(() => {
  infoCalls.length = 0;
  downloadCalls.length = 0;
  botToken = "xoxb-test";
  fileInfo = {
    id: "F1",
    name: "shot.png",
    mimetype: "image/png",
    url_private_download:
      "https://files.slack.com/files-pri/T-F1/download/shot.png",
    url_private: "https://files.slack.com/files-pri/T-F1/shot.png",
  };
  downloaded = {
    filename: "shot.png",
    mimeType: "image/png",
    data: Buffer.from([1, 2, 3, 4]).toString("base64"),
  };
});

describe("downloadSlackFileById", () => {
  test("reads the file's metadata as the bot and fetches it with the resolved token under the cap", async () => {
    const result = await downloadSlackFileById("F1", undefined, 1024);

    expect(infoCalls).toEqual(["F1"]);
    expect(downloadCalls).toEqual([
      {
        file: {
          id: "F1",
          name: "shot.png",
          mimetype: "image/png",
          urlPrivateDownload:
            "https://files.slack.com/files-pri/T-F1/download/shot.png",
          urlPrivate: "https://files.slack.com/files-pri/T-F1/shot.png",
        },
        token: "xoxb-test",
        opts: { maxBytes: 1024 },
      },
    ]);
    expect(result).toEqual({
      filename: "shot.png",
      mimeType: "image/png",
      data: Buffer.from([1, 2, 3, 4]).toString("base64"),
      size: 4,
    });
  });

  test("an id Slack does not know is unavailable, and nothing is fetched", async () => {
    fileInfo = undefined;
    await expect(
      downloadSlackFileById("F404", undefined, 1024),
    ).rejects.toBeInstanceOf(ChannelFileUnavailableError);
    expect(downloadCalls).toHaveLength(0);
  });

  test("a missing bot credential is unavailable rather than a silent null", async () => {
    botToken = null;
    await expect(
      downloadSlackFileById("F1", undefined, 1024),
    ).rejects.toBeInstanceOf(ChannelFileUnavailableError);
  });

  test("a file with no download URL is unavailable", async () => {
    downloaded = null;
    await expect(
      downloadSlackFileById("F1", undefined, 1024),
    ).rejects.toBeInstanceOf(ChannelFileUnavailableError);
  });
});
