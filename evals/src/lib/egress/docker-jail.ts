import { assertSuccess, type CommandRunner } from "../runtime/command-runner";

export interface DockerEgressJailConfig {
  /** Docker network created before `vellum hatch --remote docker` runs. */
  networkName: string;
  /** Unique assistant instance name. */
  instanceName: string;
  /** Hostnames allowed for outbound model traffic. */
  allowHosts: string[];
  /** Sidecar image that runs the local HTTP CONNECT proxy. */
  proxyImage?: string;
  /** Port exposed by the proxy sidecar inside the docker network. */
  proxyPort?: number;
}

export interface DockerEgressJail {
  proxyContainer: string;
  env: Record<string, string>;
  stop(): Promise<void>;
}

const DEFAULT_PROXY_IMAGE = "node:22-alpine";
const DEFAULT_PROXY_PORT = 8080;

const PROXY_SCRIPT = String.raw`
const http = require("http");
const net = require("net");
const allow = new Set((process.env.ALLOW_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean));
const port = Number(process.env.PROXY_PORT || "8080");
function hostAllowed(host) {
  const normalized = String(host || "").split(":")[0].toLowerCase();
  for (const allowed of allow) {
    const a = allowed.toLowerCase();
    if (normalized === a || normalized.endsWith("." + a)) return true;
  }
  return false;
}
const server = http.createServer((req, res) => {
  const target = new URL(req.url);
  if (!hostAllowed(target.hostname)) {
    res.writeHead(403);
    res.end("blocked by evals egress jail");
    return;
  }
  const upstream = http.request(target, { method: req.method, headers: req.headers }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", () => {
    res.writeHead(502);
    res.end("upstream error");
  });
  req.pipe(upstream);
});
server.on("connect", (req, client, head) => {
  const [host, rawPort] = req.url.split(":");
  const port = Number(rawPort || "443");
  if (!hostAllowed(host)) {
    client.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    client.destroy();
    return;
  }
  const upstream = net.connect(port, host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
});
server.listen(port, "0.0.0.0");
`;

/** Deterministic container names make cleanup idempotent and debuggable. */
export function dockerEgressProxyName(instanceName: string): string {
  return `${instanceName}-egress-proxy`;
}

export function egressProxyEnv(
  proxyContainer: string,
  proxyPort: number,
): Record<string, string> {
  const proxyUrl = `http://${proxyContainer}:${proxyPort}`;
  return {
    VELLUM_ASSISTANT_HTTP_PROXY: proxyUrl,
    VELLUM_ASSISTANT_HTTPS_PROXY: proxyUrl,
    VELLUM_ASSISTANT_NO_PROXY: "localhost,127.0.0.1,::1",
    VELLUM_DOCKER_NETWORK_PRECREATED: "1",
  };
}

/**
 * Prepare a block-by-default Docker network before hatching the assistant.
 *
 * Topology:
 * - `networkName` is created with `--internal`, so containers attached only to
 *   it have no direct route to the internet.
 * - The proxy sidecar starts on Docker's default bridge network, then joins the
 *   internal network with a DNS alias matching its container name.
 * - The assistant is hatched onto the pre-created internal network and receives
 *   HTTP(S)_PROXY env vars at container creation time.
 */
export async function prepareDockerEgressJail(
  runner: CommandRunner,
  config: DockerEgressJailConfig,
): Promise<DockerEgressJail> {
  const proxyPort = config.proxyPort ?? DEFAULT_PROXY_PORT;
  const proxyImage = config.proxyImage ?? DEFAULT_PROXY_IMAGE;
  const proxyContainer = dockerEgressProxyName(config.instanceName);

  await runner
    .run("docker", ["rm", "-f", proxyContainer])
    .catch(() => undefined);
  await runner
    .run("docker", ["network", "rm", config.networkName])
    .catch(() => undefined);

  const network = await runner.run("docker", [
    "network",
    "create",
    "--internal",
    config.networkName,
  ]);
  assertSuccess(network, "create docker egress network");

  const proxy = await runner.run("docker", [
    "run",
    "-d",
    "--name",
    proxyContainer,
    "--label",
    `evals.vellum.ai/instance=${config.instanceName}`,
    "--label",
    `evals.vellum.ai/allow-hosts=${config.allowHosts.join(",")}`,
    "-e",
    `ALLOW_HOSTS=${config.allowHosts.join(",")}`,
    "-e",
    `PROXY_PORT=${proxyPort}`,
    proxyImage,
    "node",
    "-e",
    PROXY_SCRIPT,
  ]);
  assertSuccess(proxy, "start docker egress proxy");

  const connect = await runner.run("docker", [
    "network",
    "connect",
    "--alias",
    proxyContainer,
    config.networkName,
    proxyContainer,
  ]);
  assertSuccess(connect, "attach egress proxy to internal network");

  return {
    proxyContainer,
    env: egressProxyEnv(proxyContainer, proxyPort),
    stop: async () => {
      await runner
        .run("docker", ["rm", "-f", proxyContainer])
        .catch(() => undefined);
      await runner
        .run("docker", ["network", "rm", config.networkName])
        .catch(() => undefined);
    },
  };
}

export function vellumDockerResourceNames(instanceName: string): {
  assistantContainer: string;
  networkName: string;
} {
  return {
    assistantContainer: `${instanceName}-assistant`,
    networkName: `${instanceName}-net`,
  };
}
