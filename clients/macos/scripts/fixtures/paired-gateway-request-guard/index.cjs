const http = require("node:http");
const fs = require("node:fs");
const { app, BrowserWindow, protocol, session } = require("electron");

const SCHEME = "paired-probe";
const HOST = "vellum.ai";
const PAIRED_PATH = "/assistant/__gateway-paired/asst-1/readyz";
const RESULT_PATH = process.env.PAIRED_GATEWAY_GUARD_RESULT_PATH;

app.commandLine.appendSwitch("use-mock-keychain");

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

app.whenReady().then(async () => {
  const observations = [];
  let pairedHandlerCalls = 0;
  let protocolHeaders = null;

  session.defaultSession.webRequest.onBeforeRequest(
    { urls: [`${SCHEME}://${HOST}${PAIRED_PATH}`] },
    (details, callback) => {
      const frameOrigin = details.frame?.origin ?? null;
      observations.push({ frameOrigin });
      callback({ cancel: frameOrigin !== `${SCHEME}://${HOST}` });
    },
  );

  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.pathname === PAIRED_PATH) {
      pairedHandlerCalls += 1;
      protocolHeaders = {
        origin: request.headers.get("origin"),
        referer: request.headers.get("referer"),
        secFetchSite: request.headers.get("sec-fetch-site"),
      };
      return Response.json({ status: "ok" });
    }
    return new Response("<html><body>trusted</body></html>", {
      headers: { "content-type": "text/html" },
    });
  });

  const trustedWindow = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  await trustedWindow.loadURL(`${SCHEME}://${HOST}/assistant`);
  const trustedStatus = await trustedWindow.webContents.executeJavaScript(
    `fetch(${JSON.stringify(`${SCHEME}://${HOST}${PAIRED_PATH}`)}).then((response) => response.status)`,
  );

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body>foreign</body></html>");
  });
  const port = await listen(server);
  const foreignWindow = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  await foreignWindow.loadURL(`http://127.0.0.1:${port}`);
  const foreignStatus = await foreignWindow.webContents.executeJavaScript(
    `fetch(${JSON.stringify(`${SCHEME}://${HOST}${PAIRED_PATH}`)})
      .then((response) => response.status)
      .catch(() => 0)`,
  );

  const result = JSON.stringify({
    trustedStatus,
    foreignStatus,
    pairedHandlerCalls,
    protocolHeaders,
    observations,
  });
  if (RESULT_PATH) {
    fs.writeFileSync(RESULT_PATH, result);
  } else {
    console.log("PAIRED_GATEWAY_GUARD_RESULT", result);
  }

  server.close();
  clearTimeout(timeout);
  app.quit();
});

const timeout = setTimeout(() => {
  console.error("paired gateway request guard fixture timed out");
  app.exit(1);
}, 15_000);
