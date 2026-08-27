import { realpathSync } from "node:fs";
import path from "node:path";

export const getCanonicalRecordingDirectories = (
  env: NodeJS.ProcessEnv = process.env,
): string[] => {
  const directories: string[] = [];
  if (env.HOME) {
    directories.push(
      path.join(
        env.HOME,
        "Library/Application Support/vellum-assistant/recordings",
      ),
    );
  }
  if (env.APPDATA) {
    directories.push(path.join(env.APPDATA, "vellum-assistant", "recordings"));
  }
  return directories.map((directory) => {
    try {
      return realpathSync(directory);
    } catch {
      return path.resolve(directory);
    }
  });
};

export const isPathWithinDirectory = (
  filePath: string,
  directory: string,
): boolean =>
  filePath === directory || filePath.startsWith(directory + path.sep);
