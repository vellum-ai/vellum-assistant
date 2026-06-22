import { execFile } from "node:child_process";

export const runAppleScript = (script: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", script],
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stderr, stdout });
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
