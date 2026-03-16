import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

import type { Command } from "commander";

import { getRuntimeHttpPort } from "../../config/env.js";
import { loadRawConfig } from "../../config/loader.js";
import { shouldAutoStartDaemon } from "../../daemon/connection-policy.js";
import { isHttpHealthy } from "../../daemon/daemon-control.js";
import { getProviderKeyAsync } from "../../security/secure-keys.js";
import {
  getDbPath,
  getHooksDir,
  getLogPath,
  getRootDir,
  getWorkspaceDir,
  getWorkspaceSkillsDir,
} from "../../util/platform.js";
import { log } from "../logger.js";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Run diagnostic checks")
    .addHelpText(
      "after",
      `
Runs a series of diagnostic checks against the local assistant environment
and prints pass/fail results. Use this to verify that the assistant is
correctly installed and configured before starting a session.

Output symbols:
  ✓   Check passed
  ✗   Check failed (detail message follows the label)

Diagnostic checks performed:
  1.  Bun is installed           Verifies bun is available in PATH
  2.  API key configured         Checks for a valid provider API key in secure storage
  3.  Assistant reachable         HTTP health check against the assistant server
  4.  Database exists/readable   Opens the SQLite database and runs a test query
  5.  Directory structure        Verifies required ~/.vellum/ directories exist
  6.  Disk space                 Ensures at least 100MB free on the data partition
  7.  Log file size              Warns if the log file exceeds 50MB
  8.  Database integrity         Runs SQLite PRAGMA integrity_check
  9.  Trust rule syntax          Validates trust.json structure and rule fields
  10. WASM files                 Checks that tree-sitter WASM binaries are present
  11. Browser runtime            Verifies Playwright and Chromium availability
  12. Sandbox diagnostics        Reports sandbox backend status and configuration

Examples:
  $ assistant doctor`,
    )
    .action(async () => {
      const pass = (label: string) => log.info(`  \u2713 ${label}`);
      const fail = (label: string, detail?: string) =>
        log.info(`  \u2717 ${label}${detail ? ` — ${detail}` : ""}`);

      log.info("Vellum Doctor\n");

      // 0. Connection policy info
      const httpUrl = `http://127.0.0.1:${getRuntimeHttpPort()}`;
      const autostart = shouldAutoStartDaemon();
      log.info(`  HTTP:      ${httpUrl}`);
      log.info(`  Autostart: ${autostart ? "enabled" : "disabled"}\n`);

      // 1. Bun installed
      try {
        execSync("bun --version", { stdio: "pipe" });
        pass("Bun is installed");
      } catch {
        fail("Bun is installed", "bun not found in PATH");
      }

      // 2. Provider/API key configured
      const raw = loadRawConfig();
      const rawServices = raw.services as
        | Record<string, Record<string, unknown>>
        | undefined;
      const rawInferenceProvider = rawServices?.inference?.provider;
      const provider =
        typeof rawInferenceProvider === "string"
          ? rawInferenceProvider
          : "anthropic";
      const configKey = await getProviderKeyAsync(provider);

      if (provider === "ollama") {
        pass("Provider configured (Ollama; API key optional)");
      } else if (configKey) {
        pass("API key configured");
      } else {
        fail("API key configured", `run: assistant keys set ${provider} <key>`);
      }

      // 3. Daemon reachable (HTTP health check)
      try {
        const healthy = await isHttpHealthy();
        if (healthy) {
          pass("Assistant reachable");
        } else {
          fail(
            "Assistant reachable",
            "HTTP health check failed (is the assistant running?)",
          );
        }
      } catch {
        fail(
          "Assistant reachable",
          "could not connect to assistant HTTP server",
        );
      }

      // 4. DB exists and readable
      const dbPath = getDbPath();
      if (existsSync(dbPath)) {
        try {
          const { Database } = await import("bun:sqlite");
          const db = new Database(dbPath, { readonly: true });
          db.query("SELECT 1").get();
          db.close();
          pass("Database exists and readable");
        } catch {
          fail(
            "Database exists and readable",
            "file exists but cannot be read",
          );
        }
      } else {
        fail("Database exists and readable", `not found at ${dbPath}`);
      }

      // 5. ~/.vellum/ directory structure (workspace layout)
      const rootDir = getRootDir();
      const dataDir = process.env.VELLUM_DATA_DIR!;
      const workspaceDir = getWorkspaceDir();
      const requiredDirs = [
        rootDir,
        workspaceDir,
        dataDir,
        `${dataDir}/db`,
        `${dataDir}/logs`,
        getWorkspaceSkillsDir(),
        getHooksDir(),
        `${rootDir}/protected`,
      ];
      const missing = requiredDirs.filter((d) => !existsSync(d));
      if (missing.length === 0) {
        pass("Directory structure exists");
      } else {
        fail("Directory structure exists", `missing: ${missing.join(", ")}`);
      }

      // 6. Disk space
      try {
        const output = execSync(`df -k "${rootDir}"`, {
          stdio: "pipe",
          encoding: "utf-8",
        });
        const lines = output.trim().split("\n");
        if (lines.length >= 2) {
          const cols = lines[1].trim().split(/\s+/);
          const availKB = parseInt(cols[3], 10);
          if (isNaN(availKB)) {
            fail("Disk space", "could not parse available space");
          } else if (availKB < 100 * 1024) {
            fail(
              "Disk space",
              `only ${Math.round(availKB / 1024)}MB free (< 100MB)`,
            );
          } else {
            pass(`Disk space (${Math.round(availKB / 1024)}MB free)`);
          }
        } else {
          fail("Disk space", "unexpected df output");
        }
      } catch {
        fail("Disk space", "could not check disk space");
      }

      // 7. Log file size
      const logPath = getLogPath();
      if (existsSync(logPath)) {
        try {
          const logStat = statSync(logPath);
          const logSizeMB = logStat.size / (1024 * 1024);
          if (logSizeMB > 50) {
            fail("Log file size", `${logSizeMB.toFixed(1)}MB (> 50MB)`);
          } else {
            pass(`Log file size (${logSizeMB.toFixed(1)}MB)`);
          }
        } catch {
          fail("Log file size", "could not stat log file");
        }
      } else {
        pass("Log file size (no log file yet)");
      }

      // 8. DB integrity check
      if (existsSync(dbPath)) {
        try {
          const { Database } = await import("bun:sqlite");
          const db = new Database(dbPath, { readonly: true });
          const result = db.query("PRAGMA integrity_check").get() as {
            integrity_check: string;
          } | null;
          db.close();
          if (result?.integrity_check === "ok") {
            pass("Database integrity check");
          } else {
            fail(
              "Database integrity check",
              result?.integrity_check ?? "unknown result",
            );
          }
        } catch (err) {
          fail(
            "Database integrity check",
            err instanceof Error ? err.message : "unknown error",
          );
        }
      } else {
        fail("Database integrity check", "database file not found");
      }

      // 9. Trust rule syntax
      const trustPath = `${rootDir}/protected/trust.json`;
      if (existsSync(trustPath)) {
        try {
          const rawTrust = readFileSync(trustPath, "utf-8");
          const data = JSON.parse(rawTrust);
          if (typeof data !== "object" || data == null) {
            fail("Trust rule syntax", "trust.json is not a JSON object");
          } else if (typeof data.version !== "number") {
            fail("Trust rule syntax", 'missing or invalid "version" field');
          } else if (!Array.isArray(data.rules)) {
            fail("Trust rule syntax", 'missing or invalid "rules" array');
          } else {
            const invalid = data.rules.filter(
              (r: unknown) =>
                typeof r !== "object" ||
                r == null ||
                typeof (r as Record<string, unknown>).tool !== "string" ||
                typeof (r as Record<string, unknown>).pattern !== "string" ||
                typeof (r as Record<string, unknown>).scope !== "string",
            );
            if (invalid.length > 0) {
              fail(
                "Trust rule syntax",
                `${invalid.length} rule(s) have invalid structure`,
              );
            } else {
              pass(`Trust rule syntax (${data.rules.length} rule(s))`);
            }
          }
        } catch (err) {
          fail(
            "Trust rule syntax",
            err instanceof Error ? err.message : "could not parse",
          );
        }
      } else {
        pass("Trust rule syntax (no trust.json yet)");
      }

      // 10. WASM files
      const wasmFiles = [
        { pkg: "web-tree-sitter", file: "web-tree-sitter.wasm" },
        { pkg: "tree-sitter-bash", file: "tree-sitter-bash.wasm" },
      ];
      let wasmOk = true;
      const missingWasm: string[] = [];
      for (const wasm of wasmFiles) {
        const dir = import.meta.dirname ?? __dirname;
        let fullPath = `${dir}/../../../node_modules/${wasm.pkg}/${wasm.file}`;
        // In compiled binaries, fall back to Resources/ or next to the binary
        if (!existsSync(fullPath) && dir.startsWith("/$bunfs/")) {
          const { dirname: pathDirname, join: pathJoin } =
            await import("node:path");
          const execDir = pathDirname(process.execPath);
          const resourcesPath = pathJoin(execDir, "..", "Resources", wasm.file);
          fullPath = existsSync(resourcesPath)
            ? resourcesPath
            : pathJoin(execDir, wasm.file);
        }
        if (!existsSync(fullPath)) {
          missingWasm.push(wasm.file);
          wasmOk = false;
        } else {
          try {
            const wasmStat = statSync(fullPath);
            if (wasmStat.size === 0) {
              missingWasm.push(`${wasm.file} (empty)`);
              wasmOk = false;
            }
          } catch {
            missingWasm.push(`${wasm.file} (unreadable)`);
            wasmOk = false;
          }
        }
      }
      if (wasmOk) {
        pass("WASM files present and non-empty");
      } else {
        fail("WASM files", missingWasm.join(", "));
      }

      // 11. Browser runtime (Playwright + Chromium)
      const { checkBrowserRuntime } =
        await import("../../tools/browser/runtime-check.js");
      const browserStatus = await checkBrowserRuntime();
      if (
        browserStatus.playwrightAvailable &&
        browserStatus.chromiumInstalled
      ) {
        pass("Browser runtime (Playwright + Chromium)");
      } else if (!browserStatus.playwrightAvailable) {
        fail("Browser runtime", "playwright not available");
      } else {
        fail(
          "Browser runtime",
          browserStatus.error ?? "Chromium not installed",
        );
      }

      // 12. Sandbox backend diagnostics
      const { runSandboxDiagnostics } =
        await import("../../tools/terminal/sandbox-diagnostics.js");
      const sandbox = runSandboxDiagnostics();
      log.info(
        `\n  Sandbox:   ${sandbox.config.enabled ? "enabled" : "disabled"}`,
      );
      log.info(`  Reason:    ${sandbox.activeBackendReason}`);
      log.info("");
      for (const check of sandbox.checks) {
        if (check.ok) {
          pass(check.label);
        } else {
          fail(check.label, check.detail);
        }
      }
    });
}
