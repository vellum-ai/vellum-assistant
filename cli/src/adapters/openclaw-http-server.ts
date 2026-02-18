import crypto from "node:crypto";
import { execSync, spawn } from "node:child_process";
import http from "node:http";

const PORT = parseInt(process.env.PORT || "7830", 10);

interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

const messages: Record<string, StoredMessage[]> = {};

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function log(method: string, path: string, status: number): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${method} ${path} -> ${status}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const method = req.method ?? "UNKNOWN";

  res.setHeader("Content-Type", "application/json");

  if (req.method === "POST" && url.pathname === "/upgrade") {
    try {
      const npmEnv = {
        ...process.env,
        PATH: `${process.env.HOME || "/root"}/.npm-global/bin:${process.env.HOME || "/root"}/.local/bin:/usr/local/bin:${process.env.PATH}`,
      };
      execSync("npm install -g @vellum/openclaw-adapter@latest", {
        encoding: "utf-8",
        timeout: 120000,
        env: npmEnv,
      });
      const child = spawn("vellum-openclaw-adapter", [], {
        detached: true,
        stdio: "ignore",
        env: npmEnv,
      });
      child.unref();
      const responseBody = JSON.stringify({
        status: "success",
        message: "HTTPS adapter installed and started. HTTP adapter shutting down.",
      });
      res.writeHead(200);
      res.end(responseBody, () => {
        log(method, url.pathname, 200);
        server.close(() => process.exit(0));
      });
    } catch (e) {
      const responseBody = JSON.stringify({
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      res.writeHead(500);
      res.end(responseBody);
      log(method, url.pathname, 500);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    const execEnv = {
      ...process.env,
      PATH: `${process.env.HOME || "/root"}/.npm-global/bin:${process.env.HOME || "/root"}/.local/bin:/usr/local/bin:${process.env.PATH}`,
    };
    let responseBody: string;
    try {
      const output = execSync("openclaw health --json", {
        encoding: "utf-8",
        timeout: 10000,
        env: execEnv,
      });
      const health = JSON.parse(output.trim()) as Record<string, unknown>;
      const result: Record<string, unknown> = {
        status: health.status ?? "healthy",
        message: health.message,
      };

      const healthStr = JSON.stringify(health);
      if (healthStr.includes("1006") || healthStr.includes("abnormal closure")) {
        try {
          const gatewayOutput = execSync("openclaw gateway status", {
            encoding: "utf-8",
            timeout: 10000,
            env: execEnv,
          });
          result.message = `${result.message}\n\nGateway Status:\n${gatewayOutput.trim()}`;
        } catch (gatewayErr) {
          const gatewayErrMsg =
            gatewayErr instanceof Error ? gatewayErr.message : String(gatewayErr);
          result.message = `${result.message}\n\nGateway Status Error:\n${gatewayErrMsg}`;
        }
      }

      responseBody = JSON.stringify(result);
      res.writeHead(200);
      res.end(responseBody);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      const result: Record<string, unknown> = {
        status: "unhealthy",
        message: errorMessage,
      };

      if (errorMessage.includes("1006") || errorMessage.includes("abnormal closure")) {
        try {
          const gatewayOutput = execSync("openclaw gateway status", {
            encoding: "utf-8",
            timeout: 10000,
            env: execEnv,
          });
          result.message = `${result.message}\n\nGateway Status:\n${gatewayOutput.trim()}`;
        } catch (gatewayErr) {
          const gatewayErrMsg =
            gatewayErr instanceof Error ? gatewayErr.message : String(gatewayErr);
          result.message = `${result.message}\n\nGateway Status Error:\n${gatewayErrMsg}`;
        }
      }

      responseBody = JSON.stringify(result);
      res.writeHead(200);
      res.end(responseBody);
    }
    log(method, url.pathname, 200);
    return;
  }

  const messagesMatch = url.pathname.match(/^\/v1\/assistants\/([^/]+)\/messages$/);
  if (messagesMatch) {
    const assistantId = messagesMatch[1];

    if (req.method === "GET") {
      const key = url.searchParams.get("conversationKey") ?? assistantId;
      const msgs = messages[key] ?? [];
      res.writeHead(200);
      res.end(JSON.stringify({ messages: msgs }));
      return;
    }

    if (req.method === "POST") {
      try {
        const parsed = await parseBody(req);
        const key = (parsed.conversationKey as string) || assistantId;
        if (!messages[key]) messages[key] = [];
        const messageId = crypto.randomUUID();
        messages[key].push({
          id: messageId,
          role: "user",
          content: parsed.content as string,
          timestamp: new Date().toISOString(),
        });
        res.writeHead(200);
        res.end(JSON.stringify({ accepted: true, messageId }));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid request body" }));
      }
      return;
    }
  }

  const notFoundBody = JSON.stringify({ error: "Not found" });
  res.writeHead(404);
  res.end(notFoundBody);
  log(method, url.pathname, 404);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenClaw runtime server listening on port ${PORT}`);
});
