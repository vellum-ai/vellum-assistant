import AppKit
import Foundation
import os
@preconcurrency import Sentry
import UniformTypeIdentifiers
import VellumAssistantShared

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
/// - `~/.config/vellum/logs/` — CLI XDG logs (hatch.log, retire.log, etc.)
/// - `~/.vellum.lock.json` — sanitized lockfile with assistant entries and resource ports (credentials stripped)
/// - `user-defaults.json` — snapshot of app-relevant UserDefaults keys
/// - `auth-debug.json` — non-sensitive token expiry and refresh state for session debugging
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

    /// Collects logs, archives them, and sends to Sentry as an attachment for developer debugging.
    static func sendLogsToSentry() {
        Task {
            let fileManager = FileManager.default
            let archiveURL = fileManager.temporaryDirectory
                .appendingPathComponent("vellum-assistant-logs-\(UUID().uuidString).tar.gz")

            do {
                try await buildArchive(destination: archiveURL)
            } catch {
                log.error("Failed to build log archive for Sentry: \(error.localizedDescription)")
                let alert = NSAlert()
                alert.messageText = "Send Failed"
                alert.informativeText = "Could not collect logs: \(error.localizedDescription)"
                alert.alertStyle = .warning
                alert.runModal()
                return
            }

            let archiveName = defaultArchiveName()
            let attachment = Attachment(path: archiveURL.path, filename: archiveName)
            let event = Event(level: .info)
            event.message = SentryMessage(formatted: "Manual log export")
            event.tags = ["source": "manual_log_export"]

            await withCheckedContinuation { continuation in
                MetricKitManager.sendManualReport(event, attachments: [attachment]) {
                    try? FileManager.default.removeItem(at: archiveURL)
                    continuation.resume()
                }
            }

            let alert = NSAlert()
            alert.messageText = "Logs Sent"
            alert.informativeText = "Log archive has been uploaded to Vellum."
            alert.alertStyle = .informational
            alert.runModal()
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

        // 5. XDG CLI logs — ~/.config/vellum/logs/ (hatch.log, retire.log, etc.)
        let xdgConfigHome = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
            ?? URL(fileURLWithPath: home).appendingPathComponent(".config").path
        let xdgLogDir = URL(fileURLWithPath: xdgConfigHome)
            .appendingPathComponent("vellum/logs", isDirectory: true)
        copyDirectoryContents(
            from: xdgLogDir,
            to: tempDir.appendingPathComponent("xdg-logs", isDirectory: true),
            fileManager: fileManager
        )

        // 6. Lockfile — ~/.vellum.lock.json (sanitized to strip credentials)
        writeSanitizedLockfile(
            to: tempDir.appendingPathComponent("vellum.lock.json")
        )

        // 7. UserDefaults snapshot — app-relevant keys for debugging
        writeUserDefaultsSnapshot(
            to: tempDir.appendingPathComponent("user-defaults.json")
        )

        // 8. Auth debug info — non-sensitive token expiry and refresh metadata
        writeAuthDebugInfo(
            to: tempDir.appendingPathComponent("auth-debug.json")
        )

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

    // MARK: - Snapshot Helpers

    /// Writes a sanitized copy of the lockfile with credential fields stripped.
    /// Preserves all structural data (assistant IDs, cloud, ports, timestamps)
    /// while replacing `bearerToken` and `runtimeUrl` with boolean presence flags.
    private nonisolated static func writeSanitizedLockfile(to url: URL) {
        guard let json = LockfilePaths.read() else { return }

        var sanitized = json
        if var assistants = json["assistants"] as? [[String: Any]] {
            for i in assistants.indices {
                let hasBearerToken = assistants[i]["bearerToken"] != nil
                let hasRuntimeUrl = assistants[i]["runtimeUrl"] != nil
                assistants[i].removeValue(forKey: "bearerToken")
                assistants[i].removeValue(forKey: "runtimeUrl")
                assistants[i]["hasBearerToken"] = hasBearerToken
                assistants[i]["hasRuntimeUrl"] = hasRuntimeUrl
            }
            sanitized["assistants"] = assistants
        }

        guard let data = try? JSONSerialization.data(
            withJSONObject: sanitized,
            options: [.prettyPrinted, .sortedKeys]
        ) else { return }
        try? data.write(to: url)
    }

    /// Writes a JSON snapshot of app-relevant UserDefaults keys.
    /// Values are included as-is for non-sensitive keys; sensitive keys are
    /// represented as presence/absence only.
    private nonisolated static func writeUserDefaultsSnapshot(to url: URL) {
        let defaults = UserDefaults.standard

        let stringKeys = [
            "connectedAssistantId",
            "connectedOrganizationId",
            "activationKey",
            "onboarding.step",
            "onboarding.name",
            "onboarding.key",
            "onboarding.cloudProvider",
            "onboarding.variant",
            "onboarding.flowVersion",
            "lastActivePanel",
            "gateway_base_url",
            "conversation_key",
            "wakeWordEnabled",
            "wakeWordKeyword",
            "sidebarExpanded",
            "windowZoomLevel",
            "conversationTextZoomLevel",
            "collectUsageDataEnabled",
            "sendPerformanceReports",
            "ttsVoiceId",
            "selectedImageGenModel",
            "activityNotificationsEnabled",
        ]

        let boolKeys = [
            "onboarding.hatched",
            "onboarding.interviewCompleted",
        ]

        var snapshot: [String: Any] = [:]
        for key in stringKeys {
            if let value = defaults.object(forKey: key) {
                snapshot[key] = value
            }
        }
        for key in boolKeys {
            snapshot[key] = defaults.bool(forKey: key)
        }

        guard let data = try? JSONSerialization.data(
            withJSONObject: snapshot,
            options: [.prettyPrinted, .sortedKeys]
        ) else { return }
        try? data.write(to: url)
    }

    /// Writes non-sensitive auth/session debug metadata: token presence,
    /// expiry timestamps, and refresh state. Actual token values are never included.
    private nonisolated static func writeAuthDebugInfo(to url: URL) {
        let now = Int(Date().timeIntervalSince1970 * 1000)

        let accessTokenExpiresAt = ActorTokenManager.getActorTokenExpiresAt()
        let refreshTokenExpiresAt = ActorTokenManager.getRefreshTokenExpiresAt()
        let refreshAfter = ActorTokenManager.getRefreshAfter()

        var info: [String: Any] = [
            "exportedAt": ISO8601DateFormatter().string(from: Date()),
            "nowEpochMs": now,
            "hasActorToken": ActorTokenManager.hasToken,
            "hasRefreshToken": ActorTokenManager.getRefreshToken() != nil,
            "hasSessionToken": SessionTokenManager.getToken() != nil,
            "needsProactiveRefresh": ActorTokenManager.needsProactiveRefresh,
            "isRefreshTokenExpired": ActorTokenManager.isRefreshTokenExpired,
        ]

        if let expiresAt = accessTokenExpiresAt {
            info["accessTokenExpiresAt"] = expiresAt
            info["accessTokenExpired"] = now >= expiresAt
        }
        if let expiresAt = refreshTokenExpiresAt {
            info["refreshTokenExpiresAt"] = expiresAt
            info["refreshTokenExpired"] = now >= expiresAt
        }
        if let refreshAfter {
            info["refreshAfter"] = refreshAfter
            info["refreshOverdue"] = now >= refreshAfter
        }

        if let guardianId = ActorTokenManager.getGuardianPrincipalId() {
            info["guardianPrincipalId"] = guardianId
        }

        // Include lockfile assistant metadata for cross-referencing
        let assistants = LockfileAssistant.loadAll()
        info["lockfileAssistantCount"] = assistants.count
        if !assistants.isEmpty {
            info["lockfileAssistants"] = assistants.map { entry -> [String: Any] in
                var dict: [String: Any] = [
                    "assistantId": entry.assistantId,
                    "cloud": entry.cloud,
                    "isManaged": entry.isManaged,
                    "isRemote": entry.isRemote,
                ]
                if let hatchedAt = entry.hatchedAt { dict["hatchedAt"] = hatchedAt }
                if let daemonPort = entry.daemonPort { dict["daemonPort"] = daemonPort }
                if let gatewayPort = entry.gatewayPort { dict["gatewayPort"] = gatewayPort }
                // Include runtimeUrl presence (not the value, which may contain tokens)
                dict["hasRuntimeUrl"] = entry.runtimeUrl != nil
                dict["hasBearerToken"] = entry.bearerToken != nil
                return dict
            }
        }

        guard let data = try? JSONSerialization.data(
            withJSONObject: info,
            options: [.prettyPrinted, .sortedKeys]
        ) else { return }
        try? data.write(to: url)
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
