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
    await (
      await import("./plugins/defaults/worker-entrypoints.js")
    ).loadDefaultMemoryWorker();
    break;
  case "routes":
    await import("./embedded/plugin-api.js");
    await import("./routes/worker.js");
    break;
  case "db-integrity": {
    const { runIntegrityCheck } =
      await import("./monitoring/db-integrity-check.js");
    console.log(JSON.stringify(runIntegrityCheck(process.argv[3] ?? "")));
    break;
  }
  default:
    throw new Error(`Unknown Windows worker entry: ${worker ?? "missing"}`);
}
