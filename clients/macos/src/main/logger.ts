import log from "electron-log/main";

log.initialize({ preload: true });

log.transports.file.maxSize = 10 * 1024 * 1024; // 10 MB
log.transports.file.fileName = "vellum.log";
log.transports.file.format =
  "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] [{processType}] {text}";

export default log;

export const getLogFilePaths = (): string[] => [
  log.transports.file.getFile().path,
];
