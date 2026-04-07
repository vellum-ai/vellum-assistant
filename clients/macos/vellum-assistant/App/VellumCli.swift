import Foundation
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "VellumCli")

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
        "VELLUM_PLATFORM_URL",
        "VELLUM_WORKSPACE_DIR",
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
        for key in forwardedEnvKeys {
            if let val = fullEnv[key] {
                env[key] = val
            }
        }
        return env
    }

    /// Writes a platform session token to the file the CLI reads for auth.
    ///
    /// The CLI's `readPlatformToken()` reads `~/.config/vellum/platform-token`.
    /// When the desktop app has a session token (via `SessionTokenManager`)
    /// but the user hasn't run `vellum login` separately, the file won't
    /// exist and the CLI will fail with "Not logged in". This bridges the
    /// gap by writing the desktop's token to the expected path.
    nonisolated private static func writePlatformTokenFile(_ token: String) {
        let configDir: String
        if let xdg = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"], !xdg.isEmpty {
            configDir = (xdg as NSString).appendingPathComponent("vellum")
        } else {
            configDir = (FileManager.default.homeDirectoryForCurrentUser.path as NSString)
                .appendingPathComponent(".config/vellum")
        }
        let tokenPath = (configDir as NSString).appendingPathComponent("platform-token")

        let fm = FileManager.default
        if !fm.fileExists(atPath: configDir) {
            try? fm.createDirectory(atPath: configDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }

        do {
            try (token + "\n").write(toFile: tokenPath, atomically: true, encoding: .utf8)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenPath)
        } catch {
            log.error("Failed to write platform token file at \(tokenPath, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Binary Discovery

    private var cliBinaryURL: URL? {
        guard let execURL = Bundle.main.executableURL else { return nil }
        let candidate = execURL.deletingLastPathComponent().appendingPathComponent("vellum-cli")
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
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

    /// How long to wait for the `sleep` CLI before giving up.
    /// The CLI sends SIGTERM then waits up to 5s (daemon) + 7s (gateway).
    nonisolated private static let stopTimeout: TimeInterval = 15.0

    /// Stops the daemon and gateway processes via `vellum sleep --force`.
    /// Waits asynchronously until the CLI exits or `stopTimeout` expires (15 seconds).
    ///
    /// Uses `--force` to bypass the phone-call keepalive lease check so
    /// the app can always shut down cleanly.
    ///
    /// Marked `nonisolated` so callers can await this without holding the
    /// main actor — important for `applicationWillTerminate` where the main
    /// thread blocks on a semaphore while waiting for this to complete.
    nonisolated func stop(name: String? = nil) async {
        guard let execURL = Bundle.main.executableURL else {
            log.info("No bundled CLI binary found — skipping stop (dev mode)")
            return
        }
        let binaryURL = execURL.deletingLastPathComponent().appendingPathComponent("vellum-cli")
        guard FileManager.default.fileExists(atPath: binaryURL.path) else {
            log.info("No bundled CLI binary found — skipping stop (dev mode)")
            return
        }

        var arguments = ["sleep", "--force"]
        if let name {
            arguments.append(name)
        }

        log.info("[audit] CLI invoke: stop args=\(arguments.dropFirst().joined(separator: " "), privacy: .public)")

        let startTime = ContinuousClock.now
        let env = Self.makeBaseEnvironment()
        let timeout = Self.stopTimeout

        let status: Int32 = await withCheckedContinuation { (continuation: CheckedContinuation<Int32, Never>) in
            let proc = Process()
            proc.executableURL = binaryURL
            proc.arguments = arguments
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice
            proc.environment = env

            let once = OnceFlag()
            let timeoutSeconds = Int(timeout)

            let timeoutItem = DispatchWorkItem { [weak proc] in
                if once.trySet() {
                    log.warning("CLI sleep timed out after \(timeoutSeconds)s — terminating process")
                    proc?.terminate()
                    continuation.resume(returning: -1)
                }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timeoutItem)

            proc.terminationHandler = { finished in
                timeoutItem.cancel()
                if once.trySet() {
                    continuation.resume(returning: finished.terminationStatus)
                }
            }

            do {
                try proc.run()
            } catch {
                timeoutItem.cancel()
                if once.trySet() {
                    log.error("Failed to launch CLI sleep: \(error.localizedDescription, privacy: .public)")
                    continuation.resume(returning: -1)
                }
            }
        }

        let elapsed = ContinuousClock.now - startTime
        let ms = elapsed.components.seconds * 1000 + Int64(elapsed.components.attoseconds / 1_000_000_000_000_000)
        log.info("[audit] CLI done: stop exit=\(status) duration=\(ms)ms")
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

    /// Run pre-upgrade steps only (backup, SSE broadcast, workspace commit) without swapping versions.
    /// Returns the backup path if one was created (parsed from stdout `BACKUP_PATH:` line).
    func upgradePrepare(name: String, targetVersion: String? = nil) async throws -> String? {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping upgradePrepare (dev mode)")
            throw CLIError.binaryNotFound
        }

        var arguments = ["upgrade", name, "--prepare"]
        if let targetVersion {
            arguments += ["--version", targetVersion]
        }
        let (stdout, stderr, status) = try await runCLI(binaryURL: binaryURL, arguments: arguments)
        if status != 0 {
            if let cliError = Self.parseCliError(from: stderr) {
                throw CLIError.structuredError(cliError)
            }
            throw CLIError.executionFailed(stderr)
        }
        // Parse BACKUP_PATH: line from stdout
        for line in stdout.split(separator: "\n") {
            if line.hasPrefix("BACKUP_PATH:") {
                return String(line.dropFirst("BACKUP_PATH:".count))
            }
        }
        return nil
    }

    /// Run post-upgrade steps only (broadcast complete, workspace commit).
    func upgradeFinalize(name: String, fromVersion: String) async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping upgradeFinalize (dev mode)")
            throw CLIError.binaryNotFound
        }

        let arguments = ["upgrade", name, "--finalize", "--version", fromVersion]
        let (_, stderr, status) = try await runCLI(binaryURL: binaryURL, arguments: arguments)
        if status != 0 {
            if let cliError = Self.parseCliError(from: stderr) {
                throw CLIError.structuredError(cliError)
            }
            throw CLIError.executionFailed(stderr)
        }
    }

    /// Roll back a specific Docker assistant to its previous version via the CLI.
    ///
    /// - Parameters:
    ///   - name: The assistant name to roll back.
    ///   - version: Optional target version to roll back to. When `nil`, rolls back to the previous version.
    func rollback(name: String, version: String? = nil) async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping rollback (dev mode)")
            throw CLIError.binaryNotFound
        }

        let versionSuffix = version.map { " to \($0)" } ?? ""
        log.info("Running rollback via CLI for '\(name, privacy: .public)'\(versionSuffix, privacy: .public)")
        var arguments = ["rollback", name]
        if let version {
            arguments += ["--version", version]
        }
        let (_, stderr, status) = try await runCLI(binaryURL: binaryURL, arguments: arguments)

        if status != 0 {
            log.error("CLI rollback failed with exit code \(status, privacy: .public): \(stderr, privacy: .private)")
            if let cliError = Self.parseCliError(from: stderr) {
                throw CLIError.structuredError(cliError)
            }
            throw CLIError.executionFailed(stderr)
        }
        log.info("CLI rollback completed successfully for '\(name, privacy: .public)'")
    }

    // MARK: - Teleport (pass-through to CLI)

    /// How long to wait for the teleport CLI command before giving up.
    /// Teleport involves export, optional hatch, and import — allow up to 10 min.
    private static let teleportTimeout: TimeInterval = 600.0

    /// Teleport an assistant's data to a different hosting environment via the CLI.
    ///
    /// Invokes `vellum teleport --from <source> --<targetEnv> [--keep-source]` and
    /// streams stdout/stderr lines to `onOutput` so the UI can display progress.
    ///
    /// The CLI handles the entire flow internally: export from source, hatch target
    /// (if needed), import to target, and optionally retire the source. After this
    /// method returns successfully the lockfile will contain the new assistant entry.
    ///
    /// - Parameters:
    ///   - from: Assistant ID (name) of the source assistant.
    ///   - targetEnv: Target environment flag: `"local"`, `"docker"`, or `"platform"`.
    ///   - keepSource: When `true`, the CLI preserves the source assistant after transfer.
    ///   - onOutput: Called on each stdout/stderr line for UI progress display.
    func teleport(
        from sourceName: String,
        targetEnv: String,
        keepSource: Bool = false,
        onOutput: @escaping @Sendable (String) -> Void
    ) async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping teleport (dev mode)")
            throw CLIError.binaryNotFound
        }

        log.info("Running teleport via CLI at \(binaryURL.path, privacy: .public) --from \(sourceName, privacy: .public) --\(targetEnv, privacy: .public)")
        log.info("[audit] CLI invoke: teleport args=--from \(sourceName, privacy: .public) --\(targetEnv, privacy: .public)\(keepSource ? " --keep-source" : "", privacy: .public)")
        let teleportStartTime = ContinuousClock.now

        var teleportArgs = ["teleport", "--from", sourceName, "--\(targetEnv)"]
        if keepSource {
            teleportArgs.append("--keep-source")
        }

        let proc = Process()
        proc.executableURL = binaryURL
        proc.arguments = teleportArgs

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe

        var env = Self.makeBaseEnvironment()

        if env["VELLUM_PLATFORM_URL"] == nil {
            #if DEBUG
            env["VELLUM_PLATFORM_URL"] = "https://dev-platform.vellum.ai"
            #else
            env["VELLUM_PLATFORM_URL"] = "https://platform.vellum.ai"
            #endif
        }

        // Forward stored provider API keys so the CLI can authenticate
        // with remote assistants during export/import.
        for (provider, envVar) in VellumCli.providerEnvVars {
            if env[envVar] == nil,
               let storedKey = APIKeyManager.getKey(for: provider),
               !storedKey.isEmpty {
                env[envVar] = storedKey
            }
        }

        // Ensure the CLI can find the platform session token.
        // The CLI reads from ~/.config/vellum/platform-token (file-based),
        // not from an environment variable. Write the desktop's token to
        // that file so the CLI can authenticate with managed/platform
        // assistants even if the user hasn't separately run `vellum login`.
        if let sessionToken = SessionTokenManager.getToken() {
            Self.writePlatformTokenFile(sessionToken)
        }

        proc.environment = env

        let stdoutHandle = stdoutPipe.fileHandleForReading
        let stderrHandle = stderrPipe.fileHandleForReading

        // Accumulate stderr so the error message includes the actual failure reason.
        let stderrAccumulator = StderrAccumulator()

        // Line buffers: readabilityHandler delivers arbitrary Data chunks,
        // not guaranteed line-delimited strings. We accumulate bytes and
        // split on newline so onOutput always receives complete lines.
        let newlineByte: UInt8 = 0x0A
        var stdoutBuffer = Data()
        var stderrBuffer = Data()
        let bufferQueue = DispatchQueue(label: "com.vellum.cli.teleport-line-buffer")

        stdoutHandle.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            bufferQueue.sync {
                stdoutBuffer.append(data)
                while let newlineIndex = stdoutBuffer.firstIndex(of: newlineByte) {
                    let lineData = stdoutBuffer[stdoutBuffer.startIndex..<newlineIndex]
                    stdoutBuffer = Data(stdoutBuffer[(newlineIndex + 1)...])
                    if let line = String(data: lineData, encoding: .utf8) {
                        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            onOutput(trimmed)
                        }
                    }
                }
            }
        }

        stderrHandle.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            bufferQueue.sync {
                stderrBuffer.append(data)
                while let newlineIndex = stderrBuffer.firstIndex(of: newlineByte) {
                    let lineData = stderrBuffer[stderrBuffer.startIndex..<newlineIndex]
                    stderrBuffer = Data(stderrBuffer[(newlineIndex + 1)...])
                    if let line = String(data: lineData, encoding: .utf8) {
                        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            stderrAccumulator.append(trimmed)
                            onOutput(trimmed)
                        }
                    }
                }
            }
        }

        // Use terminationHandler + continuation instead of waitUntilExit()
        // so the MainActor is suspended (not blocked), allowing queued
        // onOutput callbacks to update the UI while the process runs.
        let once = OnceFlag()
        let timeoutSeconds = Int(Self.teleportTimeout)

        let status: Int32 = try await withCheckedThrowingContinuation { continuation in
            let timeoutItem = DispatchWorkItem { [weak proc] in
                if once.trySet() {
                    log.error("Teleport timed out after \(timeoutSeconds) seconds — terminating CLI process")
                    proc?.terminate()
                    continuation.resume(throwing: CLIError.executionFailed("Teleport timed out after \(timeoutSeconds) seconds"))
                }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + Self.teleportTimeout, execute: timeoutItem)

            proc.terminationHandler = { finished in
                timeoutItem.cancel()
                stdoutHandle.readabilityHandler = nil
                stderrHandle.readabilityHandler = nil

                // Drain any data that arrived after the last readabilityHandler
                // callback but before we nil'd the handlers.
                let remainingStdout = stdoutHandle.availableData
                let remainingStderr = stderrHandle.availableData

                bufferQueue.sync {
                    if !remainingStdout.isEmpty {
                        stdoutBuffer.append(remainingStdout)
                        while let newlineIndex = stdoutBuffer.firstIndex(of: newlineByte) {
                            let lineData = stdoutBuffer[stdoutBuffer.startIndex..<newlineIndex]
                            stdoutBuffer = Data(stdoutBuffer[(newlineIndex + 1)...])
                            if let line = String(data: lineData, encoding: .utf8) {
                                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                                if !trimmed.isEmpty {
                                    onOutput(trimmed)
                                }
                            }
                        }
                    }

                    if !remainingStderr.isEmpty {
                        stderrBuffer.append(remainingStderr)
                        while let newlineIndex = stderrBuffer.firstIndex(of: newlineByte) {
                            let lineData = stderrBuffer[stderrBuffer.startIndex..<newlineIndex]
                            stderrBuffer = Data(stderrBuffer[(newlineIndex + 1)...])
                            if let line = String(data: lineData, encoding: .utf8) {
                                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                                if !trimmed.isEmpty {
                                    stderrAccumulator.append(trimmed)
                                    onOutput(trimmed)
                                }
                            }
                        }
                    }

                    // Flush partial lines
                    if let line = String(data: stdoutBuffer, encoding: .utf8) {
                        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            onOutput(trimmed)
                        }
                    }
                    stdoutBuffer = Data()

                    if let line = String(data: stderrBuffer, encoding: .utf8) {
                        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            stderrAccumulator.append(trimmed)
                            onOutput(trimmed)
                        }
                    }
                    stderrBuffer = Data()
                }

                guard once.trySet() else { return }
                continuation.resume(returning: finished.terminationStatus)
            }
            do {
                try proc.run()
                log.info("CLI teleport launched with pid \(proc.processIdentifier)")
            } catch {
                timeoutItem.cancel()
                stdoutHandle.readabilityHandler = nil
                stderrHandle.readabilityHandler = nil
                if once.trySet() {
                    continuation.resume(throwing: CLIError.executionFailed("Failed to launch teleport: \(error.localizedDescription)"))
                }
            }
        }

        let teleportElapsed = ContinuousClock.now - teleportStartTime
        let teleportMs = teleportElapsed.components.seconds * 1000 + Int64(teleportElapsed.components.attoseconds / 1_000_000_000_000_000)

        if status != 0 {
            let stderr = stderrAccumulator.content
            let detail = stderr.isEmpty
                ? "Teleport process exited with code \(status)"
                : stderr
            log.error("CLI teleport failed with exit code \(status): \(detail, privacy: .private)")
            log.warning("[audit] CLI done: teleport exit=\(status) duration=\(teleportMs)ms")
            throw CLIError.executionFailed(detail)
        }

        log.info("CLI teleport completed successfully")
        log.info("[audit] CLI done: teleport exit=0 duration=\(teleportMs)ms")
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

        // Line buffers: readabilityHandler delivers arbitrary Data chunks,
        // not guaranteed line-delimited strings. We accumulate bytes and
        // split on newline (0x0A) so onOutput always receives complete lines.
        let newlineByte: UInt8 = 0x0A
        var stdoutBuffer = Data()
        var stderrBuffer = Data()
        let bufferQueue = DispatchQueue(label: "com.vellum.cli.line-buffer")

        stdoutHandle.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            bufferQueue.sync {
                stdoutBuffer.append(data)
                while let newlineIndex = stdoutBuffer.firstIndex(of: newlineByte) {
                    let lineData = stdoutBuffer[stdoutBuffer.startIndex..<newlineIndex]
                    stdoutBuffer = Data(stdoutBuffer[(newlineIndex + 1)...])
                    if let line = String(data: lineData, encoding: .utf8) {
                        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            onOutput(trimmed)
                        }
                    }
                }
            }
        }

        stderrHandle.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            bufferQueue.sync {
                stderrBuffer.append(data)
                while let newlineIndex = stderrBuffer.firstIndex(of: newlineByte) {
                    let lineData = stderrBuffer[stderrBuffer.startIndex..<newlineIndex]
                    stderrBuffer = Data(stderrBuffer[(newlineIndex + 1)...])
                    if let line = String(data: lineData, encoding: .utf8) {
                        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            stderrAccumulator.append(trimmed)
                            onOutput(trimmed)
                        }
                    }
                }
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

                // Drain any data that arrived after the last readabilityHandler
                // callback but before we nil'd the handlers. Feed it through
                // the line buffers so complete lines are emitted, then flush
                // any remaining partial line.
                let remainingStdout = stdoutHandle.availableData
                let remainingStderr = stderrHandle.availableData

                bufferQueue.sync {
                    // Process remaining stdout through line buffer
                    if !remainingStdout.isEmpty {
                        stdoutBuffer.append(remainingStdout)
                        while let newlineIndex = stdoutBuffer.firstIndex(of: newlineByte) {
                            let lineData = stdoutBuffer[stdoutBuffer.startIndex..<newlineIndex]
                            stdoutBuffer = Data(stdoutBuffer[(newlineIndex + 1)...])
                            if let line = String(data: lineData, encoding: .utf8) {
                                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                                if !trimmed.isEmpty {
                                    onOutput(trimmed)
                                }
                            }
                        }
                    }

                    // Process remaining stderr through line buffer
                    if !remainingStderr.isEmpty {
                        stderrBuffer.append(remainingStderr)
                        while let newlineIndex = stderrBuffer.firstIndex(of: newlineByte) {
                            let lineData = stderrBuffer[stderrBuffer.startIndex..<newlineIndex]
                            stderrBuffer = Data(stderrBuffer[(newlineIndex + 1)...])
                            if let line = String(data: lineData, encoding: .utf8) {
                                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                                if !trimmed.isEmpty {
                                    stderrAccumulator.append(trimmed)
                                    onOutput(trimmed)
                                }
                            }
                        }
                    }

                    // Flush any remaining partial lines in the buffers
                    if let line = String(data: stdoutBuffer, encoding: .utf8) {
                        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            onOutput(trimmed)
                        }
                    }
                    stdoutBuffer = Data()

                    if let line = String(data: stderrBuffer, encoding: .utf8) {
                        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            stderrAccumulator.append(trimmed)
                            onOutput(trimmed)
                        }
                    }
                    stderrBuffer = Data()
                }

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

        // Line buffers: readabilityHandler delivers arbitrary Data chunks,
        // not guaranteed line-delimited strings. We accumulate bytes and
        // split on newline (0x0A) so onOutput always receives complete lines.
        let newlineByte: UInt8 = 0x0A
        var stdoutBuffer = Data()
        var stderrBuffer = Data()
        let bufferQueue = DispatchQueue(label: "com.vellum.cli.pair-line-buffer")

        stdoutHandle.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            bufferQueue.sync {
                stdoutBuffer.append(data)
                while let newlineIndex = stdoutBuffer.firstIndex(of: newlineByte) {
                    let lineData = stdoutBuffer[stdoutBuffer.startIndex..<newlineIndex]
                    stdoutBuffer = Data(stdoutBuffer[(newlineIndex + 1)...])
                    if let line = String(data: lineData, encoding: .utf8) {
                        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            onOutput(trimmed)
                        }
                    }
                }
            }
        }

        stderrHandle.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            bufferQueue.sync {
                stderrBuffer.append(data)
                while let newlineIndex = stderrBuffer.firstIndex(of: newlineByte) {
                    let lineData = stderrBuffer[stderrBuffer.startIndex..<newlineIndex]
                    stderrBuffer = Data(stderrBuffer[(newlineIndex + 1)...])
                    if let line = String(data: lineData, encoding: .utf8) {
                        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            stderrAccumulator.append(trimmed)
                            onOutput(trimmed)
                        }
                    }
                }
            }
        }

        // proc.run() is called INSIDE the continuation to avoid a race
        // where the process exits before terminationHandler is set.
        let status: Int32 = try await withCheckedThrowingContinuation { continuation in
            proc.terminationHandler = { finished in
                stdoutHandle.readabilityHandler = nil
                stderrHandle.readabilityHandler = nil

                // Drain any data that arrived after the last readabilityHandler
                // callback but before we nil'd the handlers. Feed it through
                // the line buffers so complete lines are emitted, then flush
                // any remaining partial line.
                let remainingStdout = stdoutHandle.availableData
                let remainingStderr = stderrHandle.availableData

                bufferQueue.sync {
                    // Process remaining stdout through line buffer
                    if !remainingStdout.isEmpty {
                        stdoutBuffer.append(remainingStdout)
                        while let newlineIndex = stdoutBuffer.firstIndex(of: newlineByte) {
                            let lineData = stdoutBuffer[stdoutBuffer.startIndex..<newlineIndex]
                            stdoutBuffer = Data(stdoutBuffer[(newlineIndex + 1)...])
                            if let line = String(data: lineData, encoding: .utf8) {
                                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                                if !trimmed.isEmpty {
                                    onOutput(trimmed)
                                }
                            }
                        }
                    }

                    // Process remaining stderr through line buffer
                    if !remainingStderr.isEmpty {
                        stderrBuffer.append(remainingStderr)
                        while let newlineIndex = stderrBuffer.firstIndex(of: newlineByte) {
                            let lineData = stderrBuffer[stderrBuffer.startIndex..<newlineIndex]
                            stderrBuffer = Data(stderrBuffer[(newlineIndex + 1)...])
                            if let line = String(data: lineData, encoding: .utf8) {
                                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                                if !trimmed.isEmpty {
                                    stderrAccumulator.append(trimmed)
                                    onOutput(trimmed)
                                }
                            }
                        }
                    }

                    // Flush any remaining partial lines in the buffers
                    if let line = String(data: stdoutBuffer, encoding: .utf8) {
                        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            onOutput(trimmed)
                        }
                    }
                    stdoutBuffer = Data()

                    if let line = String(data: stderrBuffer, encoding: .utf8) {
                        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            stderrAccumulator.append(trimmed)
                            onOutput(trimmed)
                        }
                    }
                    stderrBuffer = Data()
                }

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
