import AppKit
import Foundation
import os
import UniformTypeIdentifiers

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "LogExporter"
)

/// Collects all assistant log sources into a single `.tar.gz` archive
/// that users can share with support for debugging.
///
/// Log sources included:
/// - `~/Library/Application Support/vellum-assistant/logs/`  — per-session JSON logs
/// - `~/Library/Application Support/vellum-assistant/debug-state.json` — live debug snapshot
/// - `~/.vellum/workspace/data/logs/` — daemon rotating log files (assistant-*.log)
/// - `~/.vellum/daemon-stderr.log` — daemon stderr capture
@MainActor
enum LogExporter {

    /// Presents an NSSavePanel and writes the tar.gz archive to the chosen location.
    static func exportLogs() {
        let panel = NSSavePanel()
        panel.title = "Export Assistant Logs"
        panel.nameFieldStringValue = defaultArchiveName()
        panel.allowedContentTypes = [.gzip]
        panel.canCreateDirectories = true

        guard panel.runModal() == .OK, let destURL = panel.url else { return }

        Task {
            do {
                try await buildArchive(destination: destURL)
                log.info("Logs exported to \(destURL.path)")
                NSWorkspace.shared.activateFileViewerSelecting([destURL])
            } catch {
                log.error("Log export failed: \(error.localizedDescription)")
                let alert = NSAlert()
                alert.messageText = "Export Failed"
                alert.informativeText = error.localizedDescription
                alert.alertStyle = .warning
                alert.runModal()
            }
        }
    }

    // MARK: - Private

    private static func defaultArchiveName() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate, .withTime, .withColonSeparatorInTime]
        let timestamp = formatter.string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        return "vellum-assistant-logs-\(timestamp).tar.gz"
    }

    /// Builds a tar.gz archive containing all discoverable log files.
    /// Runs file I/O and the tar process off the main actor to avoid blocking the UI.
    private nonisolated static func buildArchive(destination: URL) async throws {
        let fileManager = FileManager.default
        let tempDir = fileManager.temporaryDirectory
            .appendingPathComponent("vellum-log-export-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: tempDir, withIntermediateDirectories: true)

        defer {
            try? fileManager.removeItem(at: tempDir)
        }

        // 1. Session logs — ~/Library/Application Support/vellum-assistant/logs/
        if let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            let sessionLogDir = appSupport.appendingPathComponent("vellum-assistant/logs", isDirectory: true)
            copyDirectoryContents(
                from: sessionLogDir,
                to: tempDir.appendingPathComponent("session-logs", isDirectory: true),
                fileManager: fileManager
            )

            // 2. Debug state snapshot
            let debugState = appSupport.appendingPathComponent("vellum-assistant/debug-state.json")
            if fileManager.fileExists(atPath: debugState.path) {
                try? fileManager.copyItem(
                    at: debugState,
                    to: tempDir.appendingPathComponent("debug-state.json")
                )
            }
        }

        // 3. Daemon logs — ~/.vellum/workspace/data/logs/
        let home = NSHomeDirectory()
        let daemonLogDir = URL(fileURLWithPath: home)
            .appendingPathComponent(".vellum/workspace/data/logs", isDirectory: true)
        copyDirectoryContents(
            from: daemonLogDir,
            to: tempDir.appendingPathComponent("daemon-logs", isDirectory: true),
            fileManager: fileManager
        )

        // 4. Daemon stderr — ~/.vellum/daemon-stderr.log
        let stderrLog = URL(fileURLWithPath: home)
            .appendingPathComponent(".vellum/daemon-stderr.log")
        if fileManager.fileExists(atPath: stderrLog.path) {
            try? fileManager.copyItem(
                at: stderrLog,
                to: tempDir.appendingPathComponent("daemon-stderr.log")
            )
        }

        // Verify we have at least one file to export
        let collected = try fileManager.contentsOfDirectory(
            at: tempDir,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )
        guard !collected.isEmpty else {
            throw ExportError.noLogsFound
        }

        // Create tar.gz using /usr/bin/tar
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
            process.arguments = [
                "czf",
                destination.path,
                "-C", tempDir.path,
                ".",
            ]

            let pipe = Pipe()
            process.standardError = pipe

            process.terminationHandler = { proc in
                if proc.terminationStatus == 0 {
                    continuation.resume()
                } else {
                    let stderr = String(
                        data: pipe.fileHandleForReading.readDataToEndOfFile(),
                        encoding: .utf8
                    ) ?? ""
                    continuation.resume(throwing: ExportError.tarFailed(stderr))
                }
            }

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }

    /// Copies all files from `source` into `dest`, creating `dest` if needed.
    /// Silently skips if `source` doesn't exist or is empty.
    private nonisolated static func copyDirectoryContents(
        from source: URL,
        to dest: URL,
        fileManager: FileManager
    ) {
        guard fileManager.fileExists(atPath: source.path) else { return }
        guard let items = try? fileManager.contentsOfDirectory(
            at: source,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ), !items.isEmpty else { return }

        try? fileManager.createDirectory(at: dest, withIntermediateDirectories: true)
        for item in items {
            try? fileManager.copyItem(
                at: item,
                to: dest.appendingPathComponent(item.lastPathComponent)
            )
        }
    }

    enum ExportError: LocalizedError {
        case noLogsFound
        case tarFailed(String)

        var errorDescription: String? {
            switch self {
            case .noLogsFound:
                return "No log files were found to export."
            case .tarFailed(let detail):
                return "Failed to create archive: \(detail)"
            }
        }
    }
}
