import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AssistantCli")

/// Manages all daemon lifecycle operations through the bundled CLI binary.
///
/// This is the single entry point for hatching, stopping, and retiring the
/// daemon. It also includes a health monitor that periodically checks whether
/// the daemon process is still alive and restarts it via the CLI.
@MainActor
final class AssistantCli {

    enum CLIError: LocalizedError {
        case binaryNotFound
        case executionFailed(String)

        var errorDescription: String? {
            switch self {
            case .binaryNotFound:
                return "CLI binary not found in app bundle"
            case .executionFailed(let message):
                return "CLI command failed: \(message)"
            }
        }
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

    private var socketURL: URL {
        vellumDir.appendingPathComponent("vellum.sock")
    }

    // MARK: - Health Monitor State

    /// Called after the daemon is restarted by the health monitor so the
    /// app layer can trigger an immediate reconnect.
    var onDaemonRestarted: (() -> Void)?

    private var healthCheckTask: Task<Void, Never>?

    /// Set to `true` during an intentional stop to prevent the health monitor
    /// from restarting the daemon.
    private var isStopping = false

    private var consecutiveCrashes = 0
    private var lastLaunchTime: Date?

    /// Once set, prevents any further automatic restart attempts.
    private var hasGivenUp = false

    /// If the daemon exits within this many seconds of being launched it
    /// counts as a crash for backoff purposes.
    private static let crashThreshold: TimeInterval = 10.0

    /// Give up restarting after this many consecutive rapid crashes.
    private static let maxConsecutiveCrashes = 5

    /// How often the health monitor checks whether the daemon is alive.
    private static let healthCheckIntervalNanos: UInt64 = 5_000_000_000 // 5 s

    /// Maximum backoff delay between restart attempts.
    private static let maxBackoffSeconds: Double = 30.0

    // MARK: - Public API

    /// Hatch a new assistant via the CLI. The CLI spawns the daemon binary,
    /// waits for the socket, and registers the assistant entry.
    ///
    /// - Parameter name: Optional assistant name to reuse (for health monitor restarts).
    func hatch(name: String? = nil, daemonOnly: Bool = false) async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping hatch (dev mode)")
            return
        }

        log.info("Running hatch via CLI at \(binaryURL.path)")

        var arguments = ["hatch", "-d"]
        if daemonOnly {
            arguments.append("--daemon-only")
        }
        if let name {
            arguments += ["--name", name]
        }

        let (_, stderr, status) = try await runCLI(binaryURL: binaryURL, arguments: arguments)

        if status != 0 {
            log.error("CLI hatch failed with exit code \(status): \(stderr)")
            throw CLIError.executionFailed(stderr)
        }

        lastLaunchTime = Date()
        log.info("CLI hatch completed successfully")
    }

    /// How long to wait for the retire CLI command before giving up.
    private static let retireTimeout: TimeInterval = 60.0

    /// Retire an assistant via the CLI. Stops the daemon, deregisters the
    /// assistant entry. Does NOT delete ~/.vellum (macOS app manages its data).
    ///
    /// Uses `terminationHandler` + `DispatchQueue` instead of `waitUntilExit()`
    /// inside `Task.detached` to avoid blocking a cooperative thread pool thread,
    /// which can cause hangs when the pool is saturated.
    ///
    /// Times out after 60 seconds; on timeout the CLI process is terminated.
    func retire(name: String) async throws {
        isStopping = true
        stopMonitoring()

        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping retire (dev mode)")
            throw CLIError.binaryNotFound
        }

        log.info("Running retire via CLI at \(binaryURL.path) for '\(name)'")

        let (stderr, status) = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<(String, Int32), Error>) in
            let proc = Process()
            proc.executableURL = binaryURL
            proc.arguments = ["retire", name]

            let stderrPipe = Pipe()
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = stderrPipe

            let fullEnv = ProcessInfo.processInfo.environment
            var env: [String: String] = [
                "HOME": NSHomeDirectory(),
                "PATH": fullEnv["PATH"] ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                "VELLUM_DESKTOP_APP": "1",
            ]
            for key in ["ANTHROPIC_API_KEY", "BASE_DATA_DIR", "VELLUM_DEBUG",
                        "SENTRY_DSN", "TMPDIR", "USER", "LANG",
                        "CLOUDSDK_CONFIG", "GOOGLE_APPLICATION_CREDENTIALS",
                        "GCP_ACCOUNT_EMAIL",
                        "AWS_PROFILE", "AWS_DEFAULT_REGION",
                        "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"] {
                if let val = fullEnv[key] { env[key] = val }
            }
            proc.environment = env

            var resumed = false
            let lock = NSLock()

            // Timeout: terminate the process if it takes too long
            let timeoutItem = DispatchWorkItem { [weak proc] in
                lock.lock()
                let alreadyResumed = resumed
                if !alreadyResumed { resumed = true }
                lock.unlock()

                if !alreadyResumed {
                    proc?.terminate()
                    continuation.resume(throwing: CLIError.executionFailed("Retire timed out after 60 seconds"))
                }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + Self.retireTimeout, execute: timeoutItem)

            proc.terminationHandler = { finished in
                timeoutItem.cancel()
                lock.lock()
                let alreadyResumed = resumed
                if !alreadyResumed { resumed = true }
                lock.unlock()

                guard !alreadyResumed else { return }

                let stderrData = stderrPipe.fileHandleForReading.availableData
                let stderrStr = String(data: stderrData, encoding: .utf8) ?? ""
                continuation.resume(returning: (stderrStr, finished.terminationStatus))
            }

            do {
                try proc.run()
            } catch {
                timeoutItem.cancel()
                lock.lock()
                let alreadyResumed = resumed
                if !alreadyResumed { resumed = true }
                lock.unlock()

                if !alreadyResumed {
                    continuation.resume(throwing: CLIError.executionFailed("Failed to launch retire: \(error.localizedDescription)"))
                }
            }
        }

        if status != 0 {
            log.error("CLI retire failed with exit code \(status): \(stderr)")
            throw CLIError.executionFailed(stderr)
        }

        log.info("CLI retire completed successfully")
    }

    /// Non-destructive stop: kills the daemon process via the CLI without
    /// deleting ~/.vellum or deregistering the assistant.
    func stop() {
        isStopping = true
        stopMonitoring()

        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping stop (dev mode)")
            // Still try to clean up via PID file in dev mode
            killViaPIDFile()
            return
        }

        log.info("Running stop via CLI at \(binaryURL.path)")

        // stop must be synchronous (called from applicationWillTerminate)
        let proc = Process()
        proc.executableURL = binaryURL
        proc.arguments = ["sleep"]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice

        let fullEnv = ProcessInfo.processInfo.environment
        proc.environment = [
            "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
            "PATH": fullEnv["PATH"] ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "TMPDIR": fullEnv["TMPDIR"] ?? NSTemporaryDirectory(),
        ]

        do {
            try proc.run()
            proc.waitUntilExit()
            log.info("CLI stop completed with exit code \(proc.terminationStatus)")
        } catch {
            log.error("CLI stop failed: \(error.localizedDescription)")
            // Fallback: kill via PID file directly
            killViaPIDFile()
        }
    }

    /// Start a periodic health check that restarts the daemon if it dies.
    /// No-op in dev mode (no bundled CLI binary).
    func startMonitoring() {
        guard cliBinaryURL != nil else { return }
        isStopping = false
        hasGivenUp = false
        consecutiveCrashes = 0
        stopMonitoring()

        healthCheckTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.healthCheckIntervalNanos)
                guard let self, !Task.isCancelled, !self.isStopping else { return }

                if !self.isDaemonAlive() {
                    log.warning("Daemon process not running — attempting restart")
                    await self.restartDaemon()
                }
            }
        }
    }

    /// Stop the health monitor.
    func stopMonitoring() {
        healthCheckTask?.cancel()
        healthCheckTask = nil
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
        var anthropicApiKey: String = ""
    }

    func runRemoteHatch(
        config: RemoteHatchConfig,
        onOutput: @escaping @Sendable (String) -> Void
    ) async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping hatch (dev mode)")
            throw CLIError.binaryNotFound
        }

        log.info("Running remote hatch via CLI at \(binaryURL.path) --remote \(config.remote)")

        let proc = Process()
        proc.executableURL = binaryURL
        proc.arguments = ["hatch", "--remote", config.remote]

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe

        var env = ProcessInfo.processInfo.environment
        env["HOME"] = FileManager.default.homeDirectoryForCurrentUser.path
        env["VELLUM_DESKTOP_APP"] = "1"

        if env["VELLUM_ASSISTANT_PLATFORM_URL"] == nil {
            env["VELLUM_ASSISTANT_PLATFORM_URL"] = "https://dev-assistant.vellum.ai"
        }

        if !config.anthropicApiKey.isEmpty {
            env["ANTHROPIC_API_KEY"] = config.anthropicApiKey
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
                env["GOOGLE_APPLICATION_CREDENTIALS"] = tmpKeyPath.path

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
        } else if config.remote == "custom" {
            if !config.sshHost.isEmpty {
                let hostString = config.sshUser.isEmpty
                    ? config.sshHost
                    : "\(config.sshUser)@\(config.sshHost)"
                env["VELLUM_CUSTOM_HOST"] = hostString
            }
            if !config.sshPrivateKey.isEmpty {
                let tmpKeyPath = FileManager.default.temporaryDirectory
                    .appendingPathComponent("vellum-ssh-key-\(ProcessInfo.processInfo.processIdentifier)")
                try config.sshPrivateKey.write(to: tmpKeyPath, atomically: true, encoding: .utf8)
                try FileManager.default.setAttributes(
                    [.posixPermissions: 0o600],
                    ofItemAtPath: tmpKeyPath.path
                )
                env["VELLUM_SSH_KEY_PATH"] = tmpKeyPath.path
            }
        }

        proc.environment = env

        try proc.run()
        log.info("CLI remote hatch launched with pid \(proc.processIdentifier)")

        let stdoutHandle = stdoutPipe.fileHandleForReading
        let stderrHandle = stderrPipe.fileHandleForReading

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
                onOutput(trimmed)
            }
        }

        proc.waitUntilExit()

        stdoutHandle.readabilityHandler = nil
        stderrHandle.readabilityHandler = nil

        let status = proc.terminationStatus
        if status != 0 {
            log.error("CLI remote hatch failed with exit code \(status)")
            throw CLIError.executionFailed("Hatch process exited with code \(status)")
        }

        log.info("CLI remote hatch completed successfully")
    }

    // MARK: - Private Helpers

    /// Returns `true` if the daemon process is alive based on the PID file.
    private func isDaemonAlive() -> Bool {
        let pidData: Data
        do {
            pidData = try Data(contentsOf: pidFileURL)
        } catch {
            log.error("Failed to read PID file at \(self.pidFileURL.path): \(error)")
            return false
        }
        guard let pidString = String(data: pidData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let pid = pid_t(pidString) else {
            return false
        }
        return kill(pid, 0) == 0
    }

    private func restartDaemon() async {
        guard cliBinaryURL != nil else { return }
        guard !hasGivenUp else { return }

        // Track consecutive rapid crashes for backoff
        if let lastLaunch = lastLaunchTime,
           Date().timeIntervalSince(lastLaunch) < Self.crashThreshold {
            consecutiveCrashes += 1
        } else {
            consecutiveCrashes = 0
        }

        if consecutiveCrashes >= Self.maxConsecutiveCrashes {
            log.error("Daemon crashed \(Self.maxConsecutiveCrashes) times in quick succession — giving up automatic restart")
            hasGivenUp = true
            return
        }

        // Exponential backoff: 1 s, 2 s, 4 s, ...
        if consecutiveCrashes > 0 {
            let backoff = min(pow(2.0, Double(consecutiveCrashes - 1)), Self.maxBackoffSeconds)
            log.info("Backoff \(backoff)s before restart attempt (consecutive crash #\(self.consecutiveCrashes))")
            try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            guard !isStopping, !Task.isCancelled else { return }
        }

        do {
            // Pass the existing assistant name so the CLI reuses it
            let existingName = UserDefaults.standard.string(forKey: "connectedAssistantId")
            try await hatch(name: existingName, daemonOnly: true)
            log.info("Daemon restarted successfully via CLI")
            onDaemonRestarted?()
        } catch {
            log.error("Failed to restart daemon: \(error.localizedDescription)")
        }
    }

    /// Kill the daemon directly via PID file — fallback when CLI binary is unavailable.
    private func killViaPIDFile() {
        let pidData: Data
        do {
            pidData = try Data(contentsOf: pidFileURL)
        } catch {
            log.error("Failed to read PID file at \(self.pidFileURL.path): \(error)")
            return
        }
        guard let pidString = String(data: pidData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let pid = pid_t(pidString),
              kill(pid, 0) == 0 else {
            return
        }

        log.info("Killing daemon via PID file (pid \(pid))")
        kill(pid, SIGTERM)

        let deadline = Date().addingTimeInterval(2.0)
        while kill(pid, 0) == 0 && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }

        if kill(pid, 0) == 0 {
            kill(pid, SIGKILL)
        }

        do {
            try FileManager.default.removeItem(at: pidFileURL)
        } catch {
            log.error("Failed to remove PID file at \(self.pidFileURL.path): \(error)")
        }
    }

    /// Run a CLI command and return (stdout, stderr, exit code).
    /// Uses Task.detached to avoid blocking the MainActor.
    private func runCLI(
        binaryURL: URL,
        arguments: [String]
    ) async throws -> (stdout: String, stderr: String, status: Int32) {
        let url = binaryURL
        let args = arguments

        return try await Task.detached {
            let proc = Process()
            proc.executableURL = url
            proc.arguments = args

            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            proc.standardOutput = stdoutPipe
            proc.standardError = stderrPipe

            // Build a minimal environment for the CLI. The app's full
            // environment contains many macOS-specific variables that slow
            // down the daemon subprocess spawned by the CLI.
            let fullEnv = ProcessInfo.processInfo.environment
            var env: [String: String] = [
                "HOME": NSHomeDirectory(),
                "PATH": fullEnv["PATH"] ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                "VELLUM_DESKTOP_APP": "1",
            ]
            // Forward optional config vars the CLI or daemon may need
            for key in ["ANTHROPIC_API_KEY", "BASE_DATA_DIR", "VELLUM_DEBUG",
                        "VELLUM_ASSISTANT_PLATFORM_URL",
                        "SENTRY_DSN", "TMPDIR", "USER", "LANG"] {
                if let val = fullEnv[key] {
                    env[key] = val
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
    }
}
