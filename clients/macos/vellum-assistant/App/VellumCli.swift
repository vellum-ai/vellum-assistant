import Foundation
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "VellumCli")

/// Thread-safe accumulator for collecting stderr output from a child process.
private final class StderrAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []

    func append(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        lines.append(line)
    }

    var content: String {
        lock.lock()
        defer { lock.unlock() }
        return lines.joined(separator: "\n")
    }
}

/// Thread-safe one-shot flag for ensuring a continuation is resumed exactly once.
private final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var set = false

    /// Returns `true` the first time it's called; `false` on every subsequent call.
    func trySet() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if set { return false }
        set = true
        return true
    }
}

/// Structured error emitted by the daemon on startup failure.
///
/// The daemon writes a `DAEMON_ERROR:{...}` JSON line to stderr when startup
/// fails. This struct captures the parsed fields so the UI can display a
/// contextual error view instead of a generic failure message.
struct DaemonStartupError {
    /// Error category (e.g. "MIGRATION_FAILED", "PORT_IN_USE", "UNKNOWN").
    let category: String
    /// Human-readable error message.
    let message: String
    /// Optional additional context (stack trace, conflicting PID, etc.).
    let detail: String?
}

/// Manages all daemon lifecycle operations through the bundled CLI binary.
///
/// This is the single entry point for hatching, stopping, and retiring the
/// daemon. It also includes a health monitor that periodically checks whether
/// the daemon process is still alive and restarts it via the CLI.
@MainActor
final class VellumCli {

    /// Structured error emitted by the CLI for upgrade/rollback failures.
    ///
    /// The CLI writes a `CLI_ERROR:{...}` JSON line to stderr when a command
    /// fails with a categorised error. This struct captures the parsed fields
    /// so the UI can display actionable guidance instead of raw stderr.
    struct CliError {
        let category: String
        let message: String
        let detail: String?
    }

    enum CLIError: LocalizedError {
        case binaryNotFound
        case executionFailed(String)
        case daemonStartupFailed(DaemonStartupError)
        case structuredError(CliError)

        var errorDescription: String? {
            switch self {
            case .binaryNotFound:
                return "CLI binary not found in app bundle"
            case .executionFailed(let message):
                return "CLI command failed: \(message)"
            case .daemonStartupFailed(let error):
                return "Assistant startup failed: \(error.message)"
            case .structuredError(let cliError):
                return "CLI command failed: \(cliError.message)"
            }
        }
    }

    // MARK: - Shared Environment

    /// Maps provider identifiers (matching `APIKeyManager` keys) to the
    /// environment variable name expected by the CLI / remote startup script.
    /// Loaded from the shared registry at `meta/provider-env-vars.json` — the
    /// single source of truth also consumed by the CLI and assistant runtime.
    nonisolated static let providerEnvVars: [String: String] =
        loadProviderEnvVarRegistry()?.providers ?? [
            "anthropic": "ANTHROPIC_API_KEY",
            "openai": "OPENAI_API_KEY",
            "gemini": "GEMINI_API_KEY",
            "fireworks": "FIREWORKS_API_KEY",
            "openrouter": "OPENROUTER_API_KEY",
            "brave": "BRAVE_API_KEY",
            "perplexity": "PERPLEXITY_API_KEY",
        ]

    /// Environment variable keys forwarded from the host process to CLI
    /// child processes. Centralised so every call site stays in sync.
    nonisolated private static let forwardedEnvKeys: [String] = [
        "BASE_DATA_DIR",
        "VELLUM_PLATFORM_URL",
        "TELEMETRY_PLATFORM_URL", "TELEMETRY_APP_TOKEN",
        "ASSISTANT_GIT_USER_NAME", "ASSISTANT_GIT_USER_EMAIL",
        "CLI_GIT_USER_NAME", "CLI_GIT_USER_EMAIL",
        "PROXY_ALLOWED_HOSTS", "HTTP_USER_AGENT", "DOCTOR_SERVICE_URL",
        "SENTRY_DSN_MACOS", "SENTRY_DSN_ASSISTANT", "TMPDIR", "USER", "LANG",
    ] + Array(providerEnvVars.values) + [
        // Cloud provider auth — needed by hatch and retire flows.
        "CLOUDSDK_CONFIG", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
        "GOOGLE_APPLICATION_CREDENTIALS", "GCP_ACCOUNT_EMAIL",
        "AWS_PROFILE", "AWS_DEFAULT_REGION",
        "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    ]

    /// Builds a minimal environment for a CLI child process, forwarding
    /// only the variables the CLI actually needs. Using the full macOS
    /// process environment causes the child to inherit paths into other
    /// apps' containers, triggering the "access data from other apps"
    /// consent dialog.
    nonisolated private static func makeBaseEnvironment() -> [String: String] {
        let fullEnv = ProcessInfo.processInfo.environment
        var env: [String: String] = [
            "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
            "PATH": fullEnv["PATH"] ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "VELLUM_DESKTOP_APP": "1",
        ]
        #if DEBUG
        // Debug builds compile out KeychainBrokerServer (#if !DEBUG), so the
        // keychain broker UDS never starts.  Tell the daemon this is a dev
        // environment so it uses the encrypted file store instead of waiting
        // for a broker that will never appear.
        env["VELLUM_DEV"] = "1"
        #endif
        for key in forwardedEnvKeys {
            if let val = fullEnv[key] {
                env[key] = val
            }
        }
        return env
    }

    // MARK: - Binary Discovery

    private var cliBinaryURL: URL? {
        guard let execURL = Bundle.main.executableURL else { return nil }
        let candidate = execURL.deletingLastPathComponent().appendingPathComponent("vellum-cli")
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
    }

    // MARK: - File Paths

    private var vellumDir: URL {
        if let baseDir = ProcessInfo.processInfo.environment["BASE_DATA_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines), !baseDir.isEmpty {
            return URL(fileURLWithPath: baseDir).appendingPathComponent(".vellum")
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".vellum")
    }

    private var pidFileURL: URL {
        vellumDir.appendingPathComponent("vellum.pid")
    }

    private var gatewayPidFileURL: URL {
        vellumDir.appendingPathComponent("gateway.pid")
    }

    // MARK: - Public API

    /// Hatch a new assistant via the CLI. The CLI spawns the daemon binary,
    /// waits for the socket, and registers the assistant entry.
    ///
    /// - Parameter name: Optional assistant name to reuse (for health monitor restarts).
    func hatch(name: String? = nil, restart: Bool = false, configValues: [String: String] = [:]) async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping hatch (dev mode)")
            return
        }

        log.info("Running hatch via CLI at \(binaryURL.path, privacy: .public)")

        var arguments = ["hatch", "-d"]
        if restart {
            arguments.append("--restart")
        }
        // NOTE: --watch runs daemon from source via `bun --watch` which breaks
        // Playwright's CDP websocket connection. Omit it for now.
        // #if DEBUG
        // arguments.append("--watch")
        // #endif
        if let name {
            arguments += ["--name", name]
        }
        for (key, value) in configValues {
            arguments.append(contentsOf: ["--config", "\(key)=\(value)"])
        }

        let (_, stderr, status) = try await runCLI(binaryURL: binaryURL, arguments: arguments)

        if status != 0 {
            log.error("CLI hatch failed with exit code \(status, privacy: .public): \(stderr, privacy: .private)")
            throw CLIError.daemonStartupFailed(Self.parseDaemonStartupError(from: stderr))
        }

        // The CLI can exit 0 even when the daemon had a startup failure
        // (e.g. it logged a warning and continued). Check stderr for the
        // DAEMON_ERROR sentinel so these failures still surface.
        if let startupError = Self.parseDaemonStartupErrorIfPresent(from: stderr) {
            log.error("CLI hatch exited 0 but daemon reported startup error [\(startupError.category, privacy: .public)]: \(startupError.message, privacy: .private)")
            throw CLIError.daemonStartupFailed(startupError)
        }

        log.info("CLI hatch completed successfully")
    }

    /// How long to wait for the retire CLI command before giving up.
    /// GCP instance deletion can take several minutes, so allow up to 5 min.
    private static let retireTimeout: TimeInterval = 300.0

    /// Retire an assistant via the CLI. Stops the daemon, deregisters the
    /// assistant entry. Does NOT delete ~/.vellum (macOS app manages its data).
    ///
    /// Uses `terminationHandler` + `DispatchQueue` instead of `waitUntilExit()`
    /// inside `Task.detached` to avoid blocking a cooperative thread pool thread,
    /// which can cause hangs when the pool is saturated.
    ///
    /// Times out after 5 minutes; on timeout the CLI process is terminated.
    /// CLI stdout/stderr are streamed to `os.Logger` so progress is visible
    /// in Console.app.
    func retire(name: String) async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping retire (dev mode)")
            throw CLIError.binaryNotFound
        }

        log.info("Running retire via CLI at \(binaryURL.path, privacy: .public) for '\(name, privacy: .public)'")
        log.info("[audit] CLI invoke: retire args=\(name, privacy: .public)")
        let retireStartTime = ContinuousClock.now

        let (stderr, status) = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<(String, Int32), Error>) in
            let proc = Process()
            proc.executableURL = binaryURL
            proc.arguments = ["retire", name]

            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            proc.standardOutput = stdoutPipe
            proc.standardError = stderrPipe

            // Stream CLI stdout/stderr to os_log so progress is visible
            // in Console.app while the retire is running.
            stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    log.info("[retire stdout] \(trimmed, privacy: .public)")
                }
            }
            stderrPipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    log.warning("[retire stderr] \(trimmed, privacy: .private)")
                }
            }

            let env = VellumCli.makeBaseEnvironment()
            proc.environment = env

            let once = OnceFlag()
            let timeoutSeconds = Int(Self.retireTimeout)

            // Timeout: terminate the process if it takes too long
            let timeoutItem = DispatchWorkItem { [weak proc] in
                if once.trySet() {
                    log.error("Retire timed out after \(timeoutSeconds) seconds — terminating CLI process")
                    proc?.terminate()
                    continuation.resume(throwing: CLIError.executionFailed("Retire timed out after \(timeoutSeconds) seconds"))
                }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + Self.retireTimeout, execute: timeoutItem)

            proc.terminationHandler = { finished in
                timeoutItem.cancel()

                // Stop streaming handlers before reading final data
                stdoutPipe.fileHandleForReading.readabilityHandler = nil
                stderrPipe.fileHandleForReading.readabilityHandler = nil

                guard once.trySet() else { return }

                let stderrData = stderrPipe.fileHandleForReading.availableData
                let stderrStr = String(data: stderrData, encoding: .utf8) ?? ""
                continuation.resume(returning: (stderrStr, finished.terminationStatus))
            }

            do {
                try proc.run()
                log.info("Retire CLI launched with pid \(proc.processIdentifier)")
            } catch {
                timeoutItem.cancel()
                stdoutPipe.fileHandleForReading.readabilityHandler = nil
                stderrPipe.fileHandleForReading.readabilityHandler = nil
                if once.trySet() {
                    continuation.resume(throwing: CLIError.executionFailed("Failed to launch retire: \(error.localizedDescription)"))
                }
            }
        }

        let retireElapsed = ContinuousClock.now - retireStartTime
        let retireMs = retireElapsed.components.seconds * 1000 + Int64(retireElapsed.components.attoseconds / 1_000_000_000_000_000)

        if status != 0 {
            log.error("CLI retire failed with exit code \(status, privacy: .public): \(stderr, privacy: .private)")
            log.warning("[audit] CLI done: retire exit=\(status) duration=\(retireMs)ms")
            throw CLIError.executionFailed(stderr)
        }

        log.info("CLI retire completed successfully")
        log.info("[audit] CLI done: retire exit=0 duration=\(retireMs)ms")
    }

    /// Non-destructive stop: sends SIGTERM to the daemon and gateway processes
    /// without waiting for them to exit. This is intentionally fire-and-forget
    /// so that applicationWillTerminate returns instantly (no beach-ball).
    /// Orphaned processes are cleaned up on next launch via `detectOrphanedProcesses`.
    func stop(name: String? = nil) {
        log.info("[audit] CLI invoke: stop args=\(name ?? "", privacy: .public)")
        signalViaPIDFile(pidFileURL, label: "daemon")
        signalViaPIDFile(gatewayPidFileURL, label: "gateway")
    }


    /// Wake a specific assistant's daemon via the CLI.
    func wake(name: String) async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping wake (dev mode)")
            return
        }

        log.info("Running wake via CLI for '\(name, privacy: .public)'")
        let (_, stderr, status) = try await runCLI(binaryURL: binaryURL, arguments: ["wake", name])

        if status != 0 {
            log.error("CLI wake failed with exit code \(status, privacy: .public): \(stderr, privacy: .private)")
            throw CLIError.executionFailed(stderr)
        }
        log.info("CLI wake completed successfully for '\(name, privacy: .public)'")
    }

    /// Sleep a specific assistant's daemon via the CLI.
    func sleep(name: String) async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping sleep (dev mode)")
            return
        }

        log.info("Running sleep via CLI for '\(name, privacy: .public)'")
        let (_, stderr, status) = try await runCLI(binaryURL: binaryURL, arguments: ["sleep", name])

        if status != 0 {
            log.error("CLI sleep failed with exit code \(status, privacy: .public): \(stderr, privacy: .private)")
            throw CLIError.executionFailed(stderr)
        }
        log.info("CLI sleep completed successfully for '\(name, privacy: .public)'")
    }

    /// Upgrade a specific assistant via the CLI.
    func upgrade(name: String, version: String? = nil) async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping upgrade (dev mode)")
            throw CLIError.binaryNotFound
        }

        let versionSuffix = version.map { " to \($0)" } ?? ""
        log.info("Running upgrade via CLI for '\(name, privacy: .public)'\(versionSuffix, privacy: .public)")
        var arguments = ["upgrade", name]
        if let version {
            arguments += ["--version", version]
        }
        let (_, stderr, status) = try await runCLI(binaryURL: binaryURL, arguments: arguments)

        if status != 0 {
            log.error("CLI upgrade failed with exit code \(status, privacy: .public): \(stderr, privacy: .private)")
            if let cliError = Self.parseCliError(from: stderr) {
                throw CLIError.structuredError(cliError)
            }
            throw CLIError.executionFailed(stderr)
        }
        log.info("CLI upgrade completed successfully for '\(name, privacy: .public)'")
    }

    /// Roll back a specific Docker assistant to its previous version via the CLI.
    func rollback(name: String) async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping rollback (dev mode)")
            throw CLIError.binaryNotFound
        }

        log.info("Running rollback via CLI for '\(name, privacy: .public)'")
        let (_, stderr, status) = try await runCLI(binaryURL: binaryURL, arguments: ["rollback", name])

        if status != 0 {
            log.error("CLI rollback failed with exit code \(status, privacy: .public): \(stderr, privacy: .private)")
            if let cliError = Self.parseCliError(from: stderr) {
                throw CLIError.structuredError(cliError)
            }
            throw CLIError.executionFailed(stderr)
        }
        log.info("CLI rollback completed successfully for '\(name, privacy: .public)'")
    }

    // MARK: - Remote Hatch (pass-through to CLI)

    struct RemoteHatchConfig {
        let remote: String
        var gcpProjectId: String = ""
        var gcpZone: String = ""
        var gcpServiceAccountKey: String = ""
        var awsRoleArn: String = ""
        var sshHost: String = ""
        var sshUser: String = ""
        var sshPrivateKey: String = ""
        /// Provider API keys keyed by env var name (e.g. "ANTHROPIC_API_KEY").
        var providerApiKeys: [String: String] = [:]
        /// Workspace config key-value pairs passed as --config flags.
        var configValues: [String: String] = [:]
    }

    func runRemoteHatch(
        config: RemoteHatchConfig,
        onOutput: @escaping @Sendable (String) -> Void
    ) async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping hatch (dev mode)")
            throw CLIError.binaryNotFound
        }

        log.info("Running remote hatch via CLI at \(binaryURL.path, privacy: .public) --remote \(config.remote, privacy: .public)")
        let cliRemoteForLog = config.remote == "customHardware" ? "custom" : config.remote
        log.info("[audit] CLI invoke: hatch args=--remote \(cliRemoteForLog, privacy: .public)")
        let remoteHatchStartTime = ContinuousClock.now

        let proc = Process()
        proc.executableURL = binaryURL
        let cliRemote = config.remote == "customHardware" ? "custom" : config.remote
        var hatchArgs = ["hatch", "--remote", cliRemote]
        #if DEBUG
        if cliRemote == "docker" {
            hatchArgs.append("--watch")
        }
        #endif
        for (key, value) in config.configValues {
            hatchArgs.append(contentsOf: ["--config", "\(key)=\(value)"])
        }
        proc.arguments = hatchArgs

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe

        var tmpFilesToCleanup: [URL] = []
        defer {
            for url in tmpFilesToCleanup {
                try? FileManager.default.removeItem(at: url)
            }
        }

        var env = Self.makeBaseEnvironment()

        if env["VELLUM_PLATFORM_URL"] == nil {
            #if DEBUG
            env["VELLUM_PLATFORM_URL"] = "https://dev-platform.vellum.ai"
            #else
            env["VELLUM_PLATFORM_URL"] = "https://platform.vellum.ai"
            #endif
        }

        for (envVar, value) in config.providerApiKeys where !value.isEmpty {
            env[envVar] = value
        }

        if config.remote == "gcp" {
            if !config.gcpProjectId.isEmpty {
                env["GCP_PROJECT"] = config.gcpProjectId
            }
            if !config.gcpZone.isEmpty {
                env["GCP_DEFAULT_ZONE"] = config.gcpZone
            }
            if !config.gcpServiceAccountKey.isEmpty {
                let tmpKeyPath = FileManager.default.temporaryDirectory
                    .appendingPathComponent("vellum-sa-key-\(ProcessInfo.processInfo.processIdentifier).json")
                try config.gcpServiceAccountKey.write(to: tmpKeyPath, atomically: true, encoding: .utf8)
                tmpFilesToCleanup.append(tmpKeyPath)
                env["GOOGLE_APPLICATION_CREDENTIALS"] = tmpKeyPath.path
                env["CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"] = tmpKeyPath.path

                if let data = config.gcpServiceAccountKey.data(using: .utf8) {
                    do {
                        if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                           let email = json["client_email"] as? String {
                            env["GCP_ACCOUNT_EMAIL"] = email
                        }
                    } catch {
                        log.error("Failed to parse GCP service account key JSON: \(error)")
                    }
                }
            }
        } else if config.remote == "aws" {
            if !config.awsRoleArn.isEmpty {
                env["VELLUM_AWS_ROLE_ARN"] = config.awsRoleArn
            }
        }

        proc.environment = env

        let stdoutHandle = stdoutPipe.fileHandleForReading
        let stderrHandle = stderrPipe.fileHandleForReading

        // Accumulate stderr so the error message includes the actual failure reason.
        let stderrAccumulator = StderrAccumulator()

        stdoutHandle.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else {
                return
            }
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                onOutput(trimmed)
            }
        }

        stderrHandle.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else {
                return
            }
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                stderrAccumulator.append(trimmed)
                onOutput(trimmed)
            }
        }

        // Use terminationHandler + continuation instead of waitUntilExit()
        // so the MainActor is suspended (not blocked), allowing queued
        // onOutput callbacks to update the UI while the process runs.
        // proc.run() is called INSIDE the continuation to avoid a race
        // where the process exits before terminationHandler is set.
        let status: Int32 = try await withCheckedThrowingContinuation { continuation in
            proc.terminationHandler = { finished in
                stdoutHandle.readabilityHandler = nil
                stderrHandle.readabilityHandler = nil
                continuation.resume(returning: finished.terminationStatus)
            }
            do {
                try proc.run()
                log.info("CLI remote hatch launched with pid \(proc.processIdentifier)")
            } catch {
                stdoutHandle.readabilityHandler = nil
                stderrHandle.readabilityHandler = nil
                continuation.resume(throwing: error)
            }
        }

        let remoteHatchElapsed = ContinuousClock.now - remoteHatchStartTime
        let remoteHatchMs = remoteHatchElapsed.components.seconds * 1000 + Int64(remoteHatchElapsed.components.attoseconds / 1_000_000_000_000_000)

        if status != 0 {
            let stderr = stderrAccumulator.content
            let detail = stderr.isEmpty
                ? "Hatch process exited with code \(status)"
                : stderr
            log.error("CLI remote hatch failed with exit code \(status): \(detail, privacy: .private)")
            log.warning("[audit] CLI done: hatch(remote) exit=\(status) duration=\(remoteHatchMs)ms")
            throw CLIError.executionFailed(detail)
        }

        log.info("CLI remote hatch completed successfully")
        log.info("[audit] CLI done: hatch(remote) exit=0 duration=\(remoteHatchMs)ms")
    }

    // MARK: - Pair (custom hardware)

    func runPair(
        qrCodeImageData: Data,
        onOutput: @escaping @Sendable (String) -> Void
    ) async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping pair (dev mode)")
            throw CLIError.binaryNotFound
        }

        let tmpQRPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("vellum-qr-code-\(ProcessInfo.processInfo.processIdentifier).png")
        try qrCodeImageData.write(to: tmpQRPath)
        defer { try? FileManager.default.removeItem(at: tmpQRPath) }

        log.info("Running pair via CLI at \(binaryURL.path, privacy: .public)")
        log.info("[audit] CLI invoke: pair")
        let pairStartTime = ContinuousClock.now

        let proc = Process()
        proc.executableURL = binaryURL
        proc.arguments = ["pair", tmpQRPath.path]

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe

        let env = Self.makeBaseEnvironment()
        proc.environment = env

        let stdoutHandle = stdoutPipe.fileHandleForReading
        let stderrHandle = stderrPipe.fileHandleForReading

        let stderrAccumulator = StderrAccumulator()

        stdoutHandle.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { onOutput(trimmed) }
        }

        stderrHandle.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                stderrAccumulator.append(trimmed)
                onOutput(trimmed)
            }
        }

        // proc.run() is called INSIDE the continuation to avoid a race
        // where the process exits before terminationHandler is set.
        let status: Int32 = try await withCheckedThrowingContinuation { continuation in
            proc.terminationHandler = { finished in
                stdoutHandle.readabilityHandler = nil
                stderrHandle.readabilityHandler = nil
                continuation.resume(returning: finished.terminationStatus)
            }
            do {
                try proc.run()
                log.info("CLI pair launched with pid \(proc.processIdentifier)")
            } catch {
                stdoutHandle.readabilityHandler = nil
                stderrHandle.readabilityHandler = nil
                continuation.resume(throwing: error)
            }
        }

        let pairElapsed = ContinuousClock.now - pairStartTime
        let pairMs = pairElapsed.components.seconds * 1000 + Int64(pairElapsed.components.attoseconds / 1_000_000_000_000_000)

        if status != 0 {
            let stderr = stderrAccumulator.content
            let detail = stderr.isEmpty
                ? "Pair process exited with code \(status)"
                : stderr
            log.error("CLI pair failed with exit code \(status): \(detail, privacy: .private)")
            log.warning("[audit] CLI done: pair exit=\(status) duration=\(pairMs)ms")
            throw CLIError.executionFailed(detail)
        }

        log.info("CLI pair completed successfully")
        log.info("[audit] CLI done: pair exit=0 duration=\(pairMs)ms")
    }

    // MARK: - Private Helpers

    /// Parse a `DaemonStartupError` from the daemon's stderr output.
    ///
    /// Scans for the last line starting with `DAEMON_ERROR:` and parses
    /// the trailing JSON. Falls back to an `UNKNOWN` category with the
    /// tail of stderr when no structured marker is found (old daemon binary).
    private static func parseDaemonStartupError(from stderr: String) -> DaemonStartupError {
        let lines = stderr.components(separatedBy: .newlines)

        // Find the last DAEMON_ERROR: line (the daemon writes exactly one,
        // but scanning from the end is more robust).
        if let markerLine = lines.last(where: { $0.hasPrefix("DAEMON_ERROR:") }) {
            let jsonString = String(markerLine.dropFirst("DAEMON_ERROR:".count))
            if let data = jsonString.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let category = json["error"] as? String ?? "UNKNOWN"
                let message = json["message"] as? String ?? "Unknown startup error"
                let detail = json["detail"] as? String
                return DaemonStartupError(category: category, message: message, detail: detail)
            }
        }

        // Fallback for old daemon binaries that don't emit DAEMON_ERROR.
        let fallbackMessage = String(stderr.suffix(500))
        return DaemonStartupError(category: "UNKNOWN", message: fallbackMessage, detail: nil)
    }

    /// Parse a `DaemonStartupError` from stderr only if the `DAEMON_ERROR:`
    /// sentinel is present. Returns `nil` when no marker is found — used for
    /// the exit-0 path where we don't want to fabricate an UNKNOWN error.
    private static func parseDaemonStartupErrorIfPresent(from stderr: String) -> DaemonStartupError? {
        let lines = stderr.components(separatedBy: .newlines)
        guard let markerLine = lines.last(where: { $0.hasPrefix("DAEMON_ERROR:") }) else {
            return nil
        }
        let jsonString = String(markerLine.dropFirst("DAEMON_ERROR:".count))
        guard let data = jsonString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        let category = json["error"] as? String ?? "UNKNOWN"
        let message = json["message"] as? String ?? "Unknown startup error"
        let detail = json["detail"] as? String
        return DaemonStartupError(category: category, message: message, detail: detail)
    }

    /// Parse a `CliError` from the CLI's stderr output.
    ///
    /// Scans for the last line starting with `CLI_ERROR:` and decodes the
    /// trailing JSON payload. Returns `nil` when no marker is found.
    static func parseCliError(from stderr: String) -> CliError? {
        let lines = stderr.components(separatedBy: "\n")
        guard let errorLine = lines.last(where: { $0.hasPrefix("CLI_ERROR:") }) else { return nil }
        let json = String(errorLine.dropFirst("CLI_ERROR:".count))
        guard let data = json.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(CliErrorPayload.self, from: data) else { return nil }
        return CliError(category: parsed.error, message: parsed.message, detail: parsed.detail)
    }

    private struct CliErrorPayload: Decodable {
        let error: String
        let message: String
        let detail: String?
    }

    /// Send SIGTERM to a process identified by a PID file. Does not wait for
    /// the process to exit — the next launch will clean up any stragglers.
    private func signalViaPIDFile(_ pidFileURL: URL, label: String) {
        guard FileManager.default.fileExists(atPath: pidFileURL.path) else { return }
        let pidData: Data
        do {
            pidData = try Data(contentsOf: pidFileURL)
        } catch {
            return
        }
        guard let pidString = String(data: pidData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let pid = pid_t(pidString),
              kill(pid, 0) == 0 else {
            return
        }

        log.info("Sending SIGTERM to \(label, privacy: .public) (pid \(pid))")
        kill(pid, SIGTERM)
    }

    /// Run a CLI command, log the invocation and result, and return
    /// (stdout, stderr, exit code). Uses Task.detached to avoid blocking
    /// the MainActor.
    private func runCLI(
        binaryURL: URL,
        arguments: [String]
    ) async throws -> (stdout: String, stderr: String, status: Int32) {
        let url = binaryURL
        let args = arguments
        let commandName = args.first ?? "<unknown>"
        let startTime = ContinuousClock.now

        log.info("[audit] CLI invoke: \(commandName, privacy: .public) args=\(args.dropFirst().joined(separator: " "), privacy: .public)")

        let result: (stdout: String, stderr: String, status: Int32)
        do {
            result = try await Task.detached {
                let proc = Process()
                proc.executableURL = url
                proc.arguments = args

                let stdoutPipe = Pipe()
                let stderrPipe = Pipe()
                proc.standardOutput = stdoutPipe
                proc.standardError = stderrPipe

                var env = VellumCli.makeBaseEnvironment()
                // Fall back to credential storage for provider API keys
                // when they're not in the process environment (e.g. app
                // launched from Finder, not a terminal with env vars set).
                for (provider, envVar) in VellumCli.providerEnvVars {
                    if env[envVar] == nil,
                       let storedKey = APIKeyManager.getKey(for: provider),
                       !storedKey.isEmpty {
                        env[envVar] = storedKey
                    }
                }
                proc.environment = env

                try proc.run()

                // Wait for the CLI process to exit first. We must NOT call
                // readDataToEndOfFile() before this because the daemon (spawned
                // by the CLI as a detached child) inherits the pipe FDs. That
                // keeps the write-end open, so readDataToEndOfFile() would block
                // until the daemon exits — causing a 15-30s hang.
                proc.waitUntilExit()

                // After the CLI exits, read whatever output is buffered in the
                // pipes. Use availableData (non-blocking) to avoid blocking on
                // inherited FDs still held by the daemon process.
                let stdoutData = stdoutPipe.fileHandleForReading.availableData
                let stderrData = stderrPipe.fileHandleForReading.availableData

                let stdoutStr = String(data: stdoutData, encoding: .utf8) ?? ""
                let stderrStr = String(data: stderrData, encoding: .utf8) ?? ""

                return (stdoutStr, stderrStr, proc.terminationStatus)
            }.value
        } catch {
            let elapsed = ContinuousClock.now - startTime
            let ms = elapsed.components.seconds * 1000 + Int64(elapsed.components.attoseconds / 1_000_000_000_000_000)
            log.error("[audit] CLI error: \(commandName, privacy: .public) threw after \(ms)ms — \(error.localizedDescription, privacy: .public)")
            throw error
        }

        let elapsed = ContinuousClock.now - startTime
        let ms = elapsed.components.seconds * 1000 + Int64(elapsed.components.attoseconds / 1_000_000_000_000_000)
        if result.status == 0 {
            log.info("[audit] CLI done: \(commandName, privacy: .public) exit=0 duration=\(ms)ms")
        } else {
            log.warning("[audit] CLI done: \(commandName, privacy: .public) exit=\(result.status) duration=\(ms)ms")
        }

        return result
    }
}
