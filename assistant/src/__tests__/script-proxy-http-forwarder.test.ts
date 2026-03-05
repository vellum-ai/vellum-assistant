import http, {
  createServer,
  type IncomingMessage,
  type Server,
} from "node:http";
import { afterEach, describe, expect, test } from "bun:test";

import { createProxyServer } from "../outbound-proxy/index.js";

/** Shape of the JSON body echoed by the upstream test server. */
interface EchoBody {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Start an HTTP server and return its URL + cleanup handle. */
function listenEphemeral(
  server: Server,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
    server.on("error", reject);
  });
}

/** Collect the full body of an IncomingMessage. */
function readBody(msg: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    msg.on("data", (c: Buffer) => chunks.push(c));
    msg.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

describe("http-forwarder", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close().catch(() => {})));
    servers.length = 0;
  });

  async function setupPair() {
    // Upstream echo server
    const upstream = createServer(async (req, res) => {
      const body = await readBody(req);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "X-Echo": "true",
      });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        }),
      );
    });
    const up = await listenEphemeral(upstream);
    servers.push(up);

    // Proxy
    const proxy = createProxyServer();
    const px = await listenEphemeral(proxy);
    servers.push(px);

    return { upstreamUrl: up.url, proxyUrl: px.url };
  }

  test("simple GET forwarded correctly", async () => {
    const { upstreamUrl, proxyUrl } = await setupPair();

    const _res = await fetch(`${proxyUrl}`, {
      method: "GET",
      // Absolute-URL form: the proxy sees the full URL as the request target
      headers: { Host: "" },
    }).then(() =>
      // Use http module style: fetch with proxy doesn't do absolute-URL form
      // So we'll directly request the proxy with the target as the URL
      fetch(proxyUrl, {
        method: "GET",
        headers: {},
      }),
    );

    // fetch doesn't support proxy mode natively — use the absolute-URL approach
    // by making a direct HTTP request to the proxy with the upstream URL as path.
    const _controller = new AbortController();
    const response = await new Promise<Response>((resolve, reject) => {
      const { hostname, port } = new URL(proxyUrl);

      const req = http.request(
        {
          hostname,
          port: Number(port),
          // Absolute URL form for HTTP proxy
          path: `${upstreamUrl}/hello?a=1`,
          method: "GET",
          headers: { "X-Custom": "test-value" },
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode!,
                headers: res.headers as Record<string, string>,
              }),
            );
          });
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as EchoBody;
    expect(data.method).toBe("GET");
    expect(data.url).toBe("/hello?a=1");
    expect(data.headers["x-custom"]).toBe("test-value");
  });

  test("POST with body forwarded correctly", async () => {
    const { upstreamUrl, proxyUrl } = await setupPair();
    const { hostname, port } = new URL(proxyUrl);

    const response = await new Promise<{ status: number; body: EchoBody }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname,
            port: Number(port),
            path: `${upstreamUrl}/submit`,
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (res: IncomingMessage) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              resolve({
                status: res.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString()),
              });
            });
          },
        );
        req.on("error", reject);
        req.write(JSON.stringify({ key: "value" }));
        req.end();
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.method).toBe("POST");
    expect(response.body.url).toBe("/submit");
    expect(response.body.body).toBe('{"key":"value"}');
  });

  test("error response forwarded correctly", async () => {
    // Upstream that returns 404
    const upstream = createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });
    const up = await listenEphemeral(upstream);
    servers.push(up);

    const proxy = createProxyServer();
    const px = await listenEphemeral(proxy);
    servers.push(px);

    const { hostname, port } = new URL(px.url);

    const response = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname,
            port: Number(port),
            path: `${up.url}/missing`,
            method: "GET",
          },
          (res: IncomingMessage) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              resolve({
                status: res.statusCode!,
                body: Buffer.concat(chunks).toString(),
              });
            });
          },
        );
        req.on("error", reject);
        req.end();
      },
    );

    expect(response.status).toBe(404);
    expect(response.body).toBe("Not Found");
  });

  test("upstream connection failure returns 502", async () => {
    const proxy = createProxyServer();
    const px = await listenEphemeral(proxy);
    servers.push(px);

    const { hostname, port } = new URL(px.url);

    // Point at a port that nothing is listening on
    const response = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname,
            port: Number(port),
            path: "http://127.0.0.1:1/unreachable",
            method: "GET",
          },
          (res: IncomingMessage) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              resolve({
                status: res.statusCode!,
                body: Buffer.concat(chunks).toString(),
              });
            });
          },
        );
        req.on("error", reject);
        req.end();
      },
    );

    expect(response.status).toBe(502);
    expect(response.body).toBe("Bad Gateway");
  });

  test("hop-by-hop headers are stripped from forwarded request", async () => {
    const { upstreamUrl, proxyUrl } = await setupPair();
    const { hostname, port } = new URL(proxyUrl);

    const response = await new Promise<{ status: number; body: EchoBody }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname,
            port: Number(port),
            path: `${upstreamUrl}/headers`,
            method: "GET",
            headers: {
              "X-Custom": "keep-me",
              "Proxy-Authorization": "secret",
              Connection: "keep-alive",
            },
          },
          (res: IncomingMessage) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              resolve({
                status: res.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString()),
              });
            });
          },
        );
        req.on("error", reject);
        req.end();
      },
    );

    expect(response.status).toBe(200);
    // Custom header should be forwarded
    expect(response.body.headers["x-custom"]).toBe("keep-me");
    // Hop-by-hop headers from the client should be stripped
    expect(response.body.headers["proxy-authorization"]).toBeUndefined();
    // Note: Node's http.request adds its own Connection header at the
    // transport level, so we only verify our explicit hop-by-hop filter
    // removed Proxy-Authorization above.
  });
});
