import { readFile, writeFile } from "node:fs/promises";

export async function writeCombinedCABundle(
  systemBundlePath: string,
  extraCAPath: string,
  outputPath: string,
): Promise<void> {
  const [systemCAs, extraCAs] = await Promise.all([
    readFile(systemBundlePath, "utf-8"),
    readFile(extraCAPath, "utf-8"),
  ]);
  await writeFile(outputPath, `${systemCAs}\n${extraCAs}`, { mode: 0o644 });
}
