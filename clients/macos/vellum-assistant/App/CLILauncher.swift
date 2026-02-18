import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "CLILauncher")

@MainActor
final class CLILauncher {

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

    private var cliBinaryURL: URL? {
        guard let execURL = Bundle.main.executableURL else { return nil }
        let candidate = execURL.deletingLastPathComponent().appendingPathComponent("vellum-cli")
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
    }

    func runHatch() async throws {
        guard let binaryURL = cliBinaryURL else {
            log.info("No bundled CLI binary found — skipping hatch (dev mode)")
            throw CLIError.binaryNotFound
        }

        log.info("Running hatch via CLI at \(binaryURL.path)")

        let proc = Process()
        proc.executableURL = binaryURL
        proc.arguments = ["hatch", "-d"]

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe

        var env = ProcessInfo.processInfo.environment
        env["HOME"] = FileManager.default.homeDirectoryForCurrentUser.path
        proc.environment = env

        try proc.run()
        log.info("CLI hatch launched with pid \(proc.processIdentifier)")

        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()

        let status = proc.terminationStatus
        if status != 0 {
            let stderrString = String(data: stderrData, encoding: .utf8) ?? ""
            log.error("CLI hatch failed with exit code \(status): \(stderrString)")
            throw CLIError.executionFailed(stderrString)
        }

        log.info("CLI hatch completed successfully")
    }
}
