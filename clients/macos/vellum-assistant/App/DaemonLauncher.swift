import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DaemonLauncher")

/// Manages the lifecycle of the bundled daemon binary.
///
/// In release builds the daemon is embedded at `Contents/MacOS/vellum-daemon`
/// inside the app bundle. In local dev (binary absent) we skip launching and
/// assume the developer runs the daemon externally.
@MainActor
final class DaemonLauncher {

    private var process: Process?
    private let vellumDir: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".vellum")
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
    }

    /// Gracefully stop the daemon (SIGTERM → wait → SIGKILL).
    func stop() {
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

    private func isAlreadyRunning() -> Bool {
        guard let pidData = try? Data(contentsOf: pidFileURL),
              let pidString = String(data: pidData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let pid = pid_t(pidString) else {
            return false
        }
        // kill(pid, 0) returns 0 if the process exists and we can signal it
        return kill(pid, 0) == 0
    }

    private func launch(binaryURL: URL) throws {
        log.info("Launching daemon from \(binaryURL.path)")

        let proc = Process()
        proc.executableURL = binaryURL
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice

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
}
