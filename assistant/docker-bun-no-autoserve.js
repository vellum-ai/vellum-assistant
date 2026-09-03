// Neuters Bun's implicit auto-serve of an entrypoint module whose default
// export carries a `fetch` method: `bun:main` calls `Bun.serve()` on that
// export, and the process then stays alive forever waiting on the socket.
//
// The assistant image ships no Node, so `bunx <pkg>` follows a bin's
// `#!/usr/bin/env node` shebang into the `node` launcher the Dockerfile
// installs, which is Bun with this file preloaded. Without the shim, any
// third-party CLI whose bundle ends in something like `export { cli as
// default }` prints its answer and then hangs until the bash tool times out.
//
// Only the implicit call is suppressed. Bun's auto-serve frame is `bun:main`,
// so an explicit `Bun.serve()` from user code (whose immediate caller frame is
// that user code) passes straight through to the real implementation.
const realServe = Bun.serve;

Bun.serve = function (options) {
  const caller = ((new Error().stack || "").split("\n")[2] || "").trim();
  if (!caller.startsWith("at bun:main")) {
    return realServe.call(Bun, options);
  }
  // Bun announces the auto-started server on the next console.debug call.
  const realDebug = console.debug;
  console.debug = (...args) => {
    console.debug = realDebug;
    if (!String(args[0]).startsWith("Started ")) {
      realDebug(...args);
    }
  };
  return {
    stop() {},
    reload() {},
    port: 0,
    hostname: "localhost",
    protocol: "http",
    development: false,
    url: new URL("http://localhost:0"),
  };
};
