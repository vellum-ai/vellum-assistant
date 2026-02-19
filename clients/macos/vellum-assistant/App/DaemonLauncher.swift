import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DaemonLauncher")

/// Manages the lifecycle of the bundled daemon binary.
///
/// In release builds the daemon is embedded at `Contents/MacOS/vellum-daemon`
/// inside the app bundle. In local dev (binary absent) we skip launching and
/// assume the developer runs the daemon externally.
///
/// Includes a health monitor that periodically checks whether the daemon
/// process is still alive and restarts it automatically if it has exited.
/// Consecutive rapid crashes trigger exponential backoff (up to 30 s) and
/// after `maxConsecutiveCrashes` failures the monitor gives up.
@MainActor
final class DaemonLauncher {

    private var process: Process?
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

    /// URL of the bundled daemon binary, if it exists.
    private var daemonBinaryURL: URL? {
        guard let execURL = Bundle.main.executableURL else { return nil }
        let candidate = execURL.deletingLastPathComponent().appendingPathComponent("vellum-daemon")
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
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

    /// Launch the bundled daemon if it isn't already running.
    /// Falls back silently when the binary isn't present (local dev).
    func launchIfNeeded() async throws {
        guard let binaryURL = daemonBinaryURL else {
            log.info("No bundled daemon binary found — assuming external daemon (dev mode)")
            return
        }

        if isAlreadyRunning() {
            log.info("Daemon already running (PID file check)")
            return
        }

        try launch(binaryURL: binaryURL)
        try await waitForSocket()
        lastLaunchTime = Date()
    }

    /// Start a periodic health check that restarts the daemon if it dies.
    /// No-op in dev mode (no bundled binary).
    func startMonitoring() {
        guard daemonBinaryURL != nil else { return }
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

    /// Gracefully stop the daemon (SIGTERM → wait → SIGKILL).
    func stop() {
        isStopping = true
        stopMonitoring()

        guard let proc = process, proc.isRunning else {
            cleanupPIDFile()
            return
        }

        log.info("Stopping daemon (pid \(proc.processIdentifier))")
        proc.terminate() // SIGTERM

        // Give it 2 seconds to exit gracefully
        let deadline = Date().addingTimeInterval(2.0)
        while proc.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }

        if proc.isRunning {
            log.warning("Daemon did not exit after SIGTERM, sending SIGKILL")
            kill(proc.processIdentifier, SIGKILL)
            proc.waitUntilExit()
        }

        process = nil
        cleanupPIDFile()
    }

    // MARK: - Private

    /// Returns `true` if the daemon process is alive — either the managed
    /// `Process` object or the PID recorded in the PID file.
    private func isDaemonAlive() -> Bool {
        if let proc = process, proc.isRunning { return true }
        return isAlreadyRunning()
    }

    private func isAlreadyRunning() -> Bool {
        guard let pidData = try? Data(contentsOf: pidFileURL),
              let pidString = String(data: pidData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let pid = pid_t(pidString) else {
            return false
        }
        // kill(pid, 0) returns 0 if the process exists and we can signal it
        return kill(pid, 0) == 0
    }

    private func restartDaemon() async {
        guard let binaryURL = daemonBinaryURL else { return }
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

        // Exponential backoff: 1 s, 2 s, 4 s, …
        if consecutiveCrashes > 0 {
            let backoff = min(pow(2.0, Double(consecutiveCrashes - 1)), Self.maxBackoffSeconds)
            log.info("Backoff \(backoff)s before restart attempt (consecutive crash #\(self.consecutiveCrashes))")
            try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            guard !isStopping, !Task.isCancelled else { return }
        }

        // Clean up stale state before relaunching
        cleanupPIDFile()
        process = nil

        do {
            try launch(binaryURL: binaryURL)
            try await waitForSocket()
            lastLaunchTime = Date()
            log.info("Daemon restarted successfully")
            onDaemonRestarted?()
        } catch {
            log.error("Failed to restart daemon: \(error.localizedDescription)")
        }
    }

    private func launch(binaryURL: URL) throws {
        log.info("Launching daemon from \(binaryURL.path)")

        // Remove stale socket file before launching so waitForSocket()
        // doesn't return prematurely on a leftover socket from a previous run.
        try? FileManager.default.removeItem(at: socketURL)

        let proc = Process()
        proc.executableURL = binaryURL
        proc.arguments = buildRemoteArgs()
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice

        // Enable TCP listener so the iOS app can connect over localhost (or LAN
        // if VELLUM_DAEMON_TCP_HOST=0.0.0.0 is set in the environment).
        var env = ProcessInfo.processInfo.environment
        env["VELLUM_DAEMON_TCP_ENABLED"] = "1"
        proc.environment = env

        // Ensure ~/.vellum/ exists for PID/socket/logs
        try FileManager.default.createDirectory(at: vellumDir, withIntermediateDirectories: true)

        try proc.run()
        process = proc
        log.info("Daemon launched with pid \(proc.processIdentifier)")
    }

    private func waitForSocket() async throws {
        let maxWait: TimeInterval = 5.0
        let pollInterval: UInt64 = 100_000_000 // 100ms in nanoseconds
        let start = Date()

        while Date().timeIntervalSince(start) < maxWait {
            if FileManager.default.fileExists(atPath: socketURL.path) {
                log.info("Daemon socket ready at \(self.socketURL.path)")
                return
            }
            try await Task.sleep(nanoseconds: pollInterval)
        }

        log.warning("Daemon socket did not appear within \(maxWait)s — continuing anyway")
    }

    private func cleanupPIDFile() {
        try? FileManager.default.removeItem(at: pidFileURL)
    }

    private static let hostingModeToRemote: [String: String] = [
        "aws": "aws",
        "customHardware": "custom",
        "gcp": "gcp",
    ]

    private func buildRemoteArgs() -> [String] {
        let configURL = vellumDir
            .appendingPathComponent("workspace")
            .appendingPathComponent("config.json")
        guard let data = try? Data(contentsOf: configURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let hostingMode = json["hostingMode"] as? String,
              let remoteValue = Self.hostingModeToRemote[hostingMode] else {
            return []
        }
        return ["--remote", remoteValue]
    }
}
