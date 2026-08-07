import "./windows-compiled-logger.js";

const worker = process.argv[2];

switch (worker) {
  case "monitoring":
    await import("./monitoring/worker.js");
    break;
  case "schedule":
    await import("./schedule/worker.js");
    break;
  case "memory":
    await import("./plugins/defaults/memory/worker.js");
    break;
  case "routes":
    await import("./embedded/plugin-api.js");
    await import("./routes/worker.js");
    break;
  default:
    throw new Error(`Unknown Windows worker entry: ${worker ?? "missing"}`);
}
