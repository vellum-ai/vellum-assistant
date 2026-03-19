import AppKit
import Foundation
import os
import OSLog
@preconcurrency import Sentry
import VellumAssistantShared

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "LogExporter"
)

/// Collects all assistant log sources into a single `.tar.gz` archive
/// that users can share with support for debugging.
///
/// Log sources included:
/// - `~/Library/Application Support/vellum-assistant/logs/`  — per-session JSONL diagnostic logs
/// - `~/Library/Application Support/vellum-assistant/debug-state.json` — live debug snapshot (includes transcript diagnostics)
/// - `~/Library/Application Support/vellum-assistant/hang-context.json` — hang diagnostic context written during main-thread stalls
/// - `~/Library/Application Support/vellum-assistant/hang-sample*.txt` — process sample captures from prolonged stalls
/// - Daemon logs, audit data, and sanitized config via `POST /v1/export` gateway HTTP API
/// - Workspace files via `POST /v1/export` — full workspace contents (config, skills, prompts, hooks, DB dump, logs)
/// - `~/.config/vellum/logs/` — CLI XDG logs (hatch.log, retire.log, etc.)
/// - `~/.vellum.lock.json` — sanitized lockfile with assistant entries and resource ports (credentials stripped)
/// - `user-defaults.json` — snapshot of app-relevant UserDefaults keys
/// - `auth-debug.json` — non-sensitive token expiry and refresh state for session debugging
/// - `port-diagnostics.json` — processes listening on assistant-relevant TCP ports
/// - `config-snapshot.json` — sanitized workspace config (API key values redacted, structure preserved)
/// - `crash-reports/` — recent macOS crash/hang reports (.ips, .crash, .spin) for assistant-related processes (bun, qdrant, vellum-assistant)
/// - `os-log.txt` — recent entries from the macOS unified log for the app's subsystem
/// - `daemon-logs-fallback/` — when daemon is unreachable: vellum.log, recent hatch-*.log, and XDG hatch.log read directly from disk (10 MB cap)
@MainActor
enum LogExporter {

    /// Whether the currently connected assistant is a managed (platform-hosted) instance.
    /// When true, conversation-scoped exports are not available because the platform API
    /// does not yet support conversation-scoped log retrieval.
    /// Uses the cached value from AppDelegate to avoid disk I/O in hot paths (e.g. SwiftUI view bodies).
    static var isManagedAssistant: Bool {
        AppDelegate.shared?.isCurrentAssistantManaged == true
    }

    /// Collects logs, archives them, and sends to Sentry as an attachment for developer debugging.
    /// Includes report metadata (reason, message) from the log report form.
    static func sendLogsToSentry(formData: LogReportFormData) {
        Task {
            let fileManager = FileManager.default
            let archiveURL = fileManager.temporaryDirectory
                .appendingPathComponent("vellum-assistant-logs-\(UUID().uuidString).tar.gz")

            do {
                try await buildArchive(destination: archiveURL, formData: formData)
            } catch {
                log.error("Failed to build log archive for Sentry: \(error.localizedDescription)")
                NSApp.activate(ignoringOtherApps: true)
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
            let errorTitle: String
            switch formData.scope {
            case .conversation(_, let conversationTitle, _, _):
                errorTitle = "\(formData.reason.displayName) log report (conversation: \(conversationTitle))"
            case .global:
                errorTitle = "\(formData.reason.displayName) log report"
            }
            event.message = SentryMessage(formatted: errorTitle)
            // Set error so Sentry displays the error message (not "No error message provided").
            event.error = NSError(
                domain: "com.vellum.log-report",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: errorTitle]
            )
            var tags: [String: String] = [
                "source": "log_report",
                "report_reason": formData.reason.rawValue,
            ]
            if case .conversation(let conversationId, _, _, _) = formData.scope {
                tags["conversation_id"] = conversationId
                tags["export_scope"] = "conversation"
            } else {
                tags["export_scope"] = "global"
            }
            // When routing to the brain project, tag the event so it's clear
            // it originated from the macOS client (not the daemon itself).
            if formData.reason == .assistantBehavior {
                tags["client"] = "macos"
            }

            // Surface active conversation state as tags so the Sentry event itself
            // is useful for triage without downloading the log archive.
            var extra: [String: Any] = [:]
            let conversationManager = AppDelegate.shared?.mainWindow?.conversationManager
            if let activeConversation = conversationManager?.activeConversation {
                extra["conversation_title"] = activeConversation.title
                if let conversationId = activeConversation.conversationId {
                    // Setting conversation_id enables cross-project search: find
                    // the daemon error that corresponds to a macOS log report by
                    // querying conversation_id in the vellum-assistant-brain
                    // Sentry project.
                    // For conversation-scoped exports, conversation_id was already set
                    // to the reported conversation's ID above — don't overwrite it with
                    // the active conversation's ID.
                    if case .global = formData.scope {
                        tags["conversation_id"] = conversationId
                    }
                }
            }
            var errorCategoryString: String?
            if let vm = conversationManager?.activeViewModel {
                extra["message_count"] = vm.messages.count
                if let conversationError = vm.conversationError {
                    let category = "\(conversationError.category)"
                    tags["conversation_error_category"] = category
                    errorCategoryString = category
                    if let debugDetails = conversationError.debugDetails {
                        extra["conversation_error_debug_details"] = debugDetails
                    }
                }
                if let conversationId = vm.conversationId {
                    // Prefer the view model's conversationId (most up-to-date)
                    tags["conversation_id"] = conversationId
                    // For conversation-scoped exports, conversation_id reflects the
                    // reported conversation, not the active one — skip the overwrite.
                    if case .global = formData.scope {
                        tags["conversation_id"] = conversationId
                    }
                }
            }
            if let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") {
                tags["assistant_id"] = assistantId
            }
            if !extra.isEmpty {
                event.extra = extra
            }

            event.tags = tags
            // Group reports by reason and error category so different root
            // causes (e.g. providerApi vs contextTooLarge) create separate
            // Sentry issues instead of being mixed into one.
            let categoryComponent = errorCategoryString ?? "none"
            event.fingerprint = ["log_report", formData.reason.rawValue, categoryComponent]

            // User-provided context (message, email, category) is sent via
            // Sentry's Feedback API, linked to the event. This keeps PII
            // out of event tags/extras and lets us use Sentry's built-in
            // feedback UI for triage.
            let feedback = MetricKitManager.UserFeedbackData(
                comments: formData.message.isEmpty ? nil : formData.message,
                email: formData.email,
                name: formData.name.isEmpty ? nil : formData.name
            )

            // Route assistant behavior reports to the brain Sentry project
            // so they appear alongside daemon issues for triage.
            let dsn: String? = formData.reason == .assistantBehavior
                ? MetricKitManager.brainDSN
                : nil

            await withCheckedContinuation { continuation in
                MetricKitManager.sendManualReport(
                    event,
                    attachments: [attachment],
                    userFeedback: feedback,
                    dsn: dsn
                ) {
                    try? FileManager.default.removeItem(at: archiveURL)
                    continuation.resume()
                }
            }

            // Re-activate before showing the alert in case the app reverted
            // to .accessory policy after the log report window was dismissed.
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "Log Sent"
            alert.informativeText = "Your log report has been sent to Vellum."
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
    private nonisolated static func buildArchive(destination: URL, formData: LogReportFormData? = nil) async throws {
        let fileManager = FileManager.default
        let tempDir = fileManager.temporaryDirectory
            .appendingPathComponent("vellum-log-export-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: tempDir, withIntermediateDirectories: true)

        defer {
            try? fileManager.removeItem(at: tempDir)
        }

        // 1-2. Client artifacts — session logs, debug-state, hang-context, hang-sample files
        if let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            let appSupportDir = appSupport.appendingPathComponent("vellum-assistant", isDirectory: true)
            collectClientArtifacts(from: appSupportDir, into: tempDir, fileManager: fileManager)
        }

        // 3. Assistant logs — platform API for managed, local gateway for self-hosted
        let home = NSHomeDirectory()
        let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
        let connectedAssistant = connectedId.flatMap { LockfileAssistant.loadByName($0) }
        let isManagedAssistant = connectedAssistant?.isManaged == true

        var daemonUnreachable = false
        if isManagedAssistant, let assistantId = connectedId,
           let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId") {
            await fetchPlatformLogs(into: tempDir, assistantId: assistantId, organizationId: orgId)
        } else {
            let success = await fetchDaemonExports(into: tempDir, scope: formData?.scope ?? .global)
            if !success {
                daemonUnreachable = true
                collectFallbackDaemonLogs(
                    into: tempDir,
                    home: home,
                    connectedAssistant: connectedAssistant,
                    fileManager: fileManager
                )
            }
        }

        // 4. XDG CLI logs — ~/.config/vellum/logs/ (hatch.log, retire.log, etc.)
        let xdgConfigHome = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
            ?? URL(fileURLWithPath: home).appendingPathComponent(".config").path
        let xdgLogDir = URL(fileURLWithPath: xdgConfigHome)
            .appendingPathComponent("vellum/logs", isDirectory: true)
        copyDirectoryContents(
            from: xdgLogDir,
            to: tempDir.appendingPathComponent("xdg-logs", isDirectory: true),
            fileManager: fileManager
        )

        // 5. Lockfile — ~/.vellum.lock.json (sanitized to strip credentials)
        writeSanitizedLockfile(
            to: tempDir.appendingPathComponent("vellum.lock.json")
        )

        // 6. UserDefaults snapshot — app-relevant keys for debugging
        writeUserDefaultsSnapshot(
            to: tempDir.appendingPathComponent("user-defaults.json")
        )

        // 7. Auth debug info — non-sensitive token expiry and refresh metadata
        writeAuthDebugInfo(
            to: tempDir.appendingPathComponent("auth-debug.json")
        )

        // 8. Port diagnostics — which processes are listening on assistant ports
        PortDiagnostics.write(
            to: tempDir.appendingPathComponent("port-diagnostics.json")
        )

        // 9. macOS crash/hang reports — recent .ips/.crash/.spin files for assistant-related processes
        collectCrashReports(
            into: tempDir.appendingPathComponent("crash-reports", isDirectory: true),
            fileManager: fileManager
        )

        // 10. Report metadata — reason and message from the log report form.
        // Email is excluded from the archive since it's already sent via
        // Sentry's Feedback API (linked to the event).
        if let formData {
            var metadata: [String: Any] = [
                "reason": formData.reason.rawValue,
                "message": formData.message,
                // device_id intentionally matches ~/.vellum/device.json UUID
                // so log exports correlate with daemon Sentry events and telemetry.
                "device_id": SentryDeviceInfo.deviceId,
            ]
            // user_id mirrors the Sentry user tag set by SentryDeviceInfo.updateUserTag
            // so log exports can be correlated with authenticated Sentry events.
            if let userId = AppDelegate.shared?.authManager.currentUser?.id {
                metadata["user_id"] = userId
            }
            if !formData.name.isEmpty {
                metadata["name"] = formData.name
            }
            if daemonUnreachable {
                metadata["daemon-unreachable"] = true
            }
            if let data = try? JSONSerialization.data(
                withJSONObject: metadata,
                options: [.prettyPrinted, .sortedKeys]
            ) {
                try? data.write(to: tempDir.appendingPathComponent("report-metadata.json"))
            }
        } else if daemonUnreachable {
            // Write a minimal manifest when no form data is available so the
            // receiving end still knows these are raw filesystem reads.
            let manifest: [String: Any] = ["daemon-unreachable": true]
            if let data = try? JSONSerialization.data(
                withJSONObject: manifest,
                options: [.prettyPrinted, .sortedKeys]
            ) {
                try? data.write(to: tempDir.appendingPathComponent("report-metadata.json"))
            }
        }

        // 11. macOS unified log — recent os.Logger entries for this app's subsystem.
        collectUnifiedLog(
            to: tempDir.appendingPathComponent("os-log.txt")
        )

        // 12. Sanitized workspace config — client-side fallback if daemon export didn't include it.
        //     The daemon archive extracts into daemon-exports/, so check both locations.
        let configSnapshotPath = tempDir.appendingPathComponent("config-snapshot.json")
        let daemonConfigPath = tempDir.appendingPathComponent("daemon-exports/config-snapshot.json")
        if !fileManager.fileExists(atPath: configSnapshotPath.path)
            && !fileManager.fileExists(atPath: daemonConfigPath.path) {
            writeSanitizedWorkspaceConfig(to: configSnapshotPath)
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

    // MARK: - Client Artifact Collection

    /// Copies client-side diagnostic artifacts from the Application Support
    /// `vellum-assistant/` directory into the export staging directory.
    ///
    /// Artifacts collected:
    /// - `logs/` — per-session JSONL diagnostic logs (→ `session-logs/`)
    /// - `debug-state.json` — live debug snapshot
    /// - `hang-context.json` — hang diagnostic context from main-thread stalls
    /// - `hang-sample*.txt` — process sample captures from prolonged stalls
    ///
    /// All copies are best-effort: missing files are silently skipped.
    nonisolated static func collectClientArtifacts(
        from sourceDir: URL,
        into destDir: URL,
        fileManager: FileManager = .default
    ) {
        // Session logs
        let sessionLogDir = sourceDir.appendingPathComponent("logs", isDirectory: true)
        copyDirectoryContents(
            from: sessionLogDir,
            to: destDir.appendingPathComponent("session-logs", isDirectory: true),
            fileManager: fileManager
        )

        // Debug state snapshot
        let debugState = sourceDir.appendingPathComponent("debug-state.json")
        if fileManager.fileExists(atPath: debugState.path) {
            try? fileManager.copyItem(
                at: debugState,
                to: destDir.appendingPathComponent("debug-state.json")
            )
        }

        // Hang context — written by MainThreadStallDetector during prolonged stalls
        let hangContext = sourceDir.appendingPathComponent("hang-context.json")
        if fileManager.fileExists(atPath: hangContext.path) {
            try? fileManager.copyItem(
                at: hangContext,
                to: destDir.appendingPathComponent("hang-context.json")
            )
        }

        // Hang sample files — process samples captured during prolonged main-thread stalls
        if fileManager.fileExists(atPath: sourceDir.path),
           let contents = try? fileManager.contentsOfDirectory(
               at: sourceDir,
               includingPropertiesForKeys: nil,
               options: [.skipsHiddenFiles]
           ) {
            for file in contents where file.lastPathComponent.hasPrefix("hang-sample")
                && file.pathExtension == "txt" {
                try? fileManager.copyItem(
                    at: file,
                    to: destDir.appendingPathComponent(file.lastPathComponent)
                )
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

    // MARK: - Daemon HTTP Helpers

    /// Calls POST /v1/export on the gateway to download a tar.gz archive of
    /// audit data, daemon logs, workspace files, and config snapshot.
    /// Extracts the archive into `directory/daemon-exports/`.
    /// Returns `true` if the export succeeded, `false` if the daemon was unreachable.
    @discardableResult
    private nonisolated static func fetchDaemonExports(into directory: URL, scope: LogExportScope) async -> Bool {
        let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
        let baseURL = LockfilePaths.resolveGatewayUrl(connectedAssistantId: connectedId)

        guard let token = ActorTokenManager.getToken(), !token.isEmpty else {
            log.warning("No actor token available — skipping daemon exports")
            return false
        }

        guard let url = URL(string: "\(baseURL)/v1/export") else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["auditLimit": 10000]
        if case .conversation(let conversationId, _, let startTime, let endTime) = scope {
            body["conversationId"] = conversationId
            if let startTime {
                body["startTime"] = Int(startTime.timeIntervalSince1970 * 1000)
            }
            if let endTime {
                body["endTime"] = Int(endTime.timeIntervalSince1970 * 1000)
            }
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200...299).contains(http.statusCode) else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                log.warning("Export API failed with status \(status)")
                return false
            }

            try await extractTarGzResponse(data: data, into: directory, subdirectory: "daemon-exports")
            return true
        } catch {
            log.warning("Export API request failed: \(error.localizedDescription)")
            return false
        }
    }

    // MARK: - Daemon Log Fallback

    /// Maximum total bytes to read when collecting fallback daemon logs.
    private nonisolated static let fallbackLogSizeLimit = 10 * 1024 * 1024 // 10 MB

    /// When the daemon is unreachable, reads log files directly from the
    /// filesystem and copies them into `directory/daemon-logs-fallback/`.
    /// Includes the main daemon log (`vellum.log`) and the 3 most recent
    /// hatch attempt logs (`hatch-*.log`), capped at 10 MB total.
    ///
    /// Resolves the workspace log directory from the connected assistant's
    /// lockfile entry (via `instanceDir` or `baseDataDir`) to support
    /// multi-instance setups. Falls back to `~/.vellum/workspace/` when
    /// no lockfile entry is available.
    private nonisolated static func collectFallbackDaemonLogs(
        into directory: URL,
        home: String,
        connectedAssistant: LockfileAssistant?,
        fileManager: FileManager
    ) {
        let fallbackDir = directory.appendingPathComponent("daemon-logs-fallback", isDirectory: true)
        try? fileManager.createDirectory(at: fallbackDir, withIntermediateDirectories: true)

        let workspaceDir: String = connectedAssistant?.workspaceDir
            ?? URL(fileURLWithPath: home).appendingPathComponent(".vellum/workspace").path
        let workspaceLogDir = URL(fileURLWithPath: workspaceDir)
            .appendingPathComponent("data/logs", isDirectory: true)

        var totalBytes = 0

        // 1. Main daemon log — vellum.log
        let vellumLog = workspaceLogDir.appendingPathComponent("vellum.log")
        if fileManager.fileExists(atPath: vellumLog.path),
           let attrs = try? fileManager.attributesOfItem(atPath: vellumLog.path),
           let size = attrs[.size] as? Int,
           size > 0 {
            let bytesToRead = min(size, fallbackLogSizeLimit - totalBytes)
            if bytesToRead > 0 {
                if bytesToRead >= size {
                    try? fileManager.copyItem(
                        at: vellumLog,
                        to: fallbackDir.appendingPathComponent("vellum.log")
                    )
                } else {
                    // Tail the file if it exceeds the remaining budget
                    copyTail(
                        of: vellumLog,
                        bytes: bytesToRead,
                        to: fallbackDir.appendingPathComponent("vellum.log")
                    )
                }
                totalBytes += bytesToRead
            }
        }

        // 2. Recent hatch attempt logs — hatch-*.log, sorted by modification time (newest first)
        if fileManager.fileExists(atPath: workspaceLogDir.path),
           let contents = try? fileManager.contentsOfDirectory(
               at: workspaceLogDir,
               includingPropertiesForKeys: [.contentModificationDateKey],
               options: [.skipsHiddenFiles]
           ) {
            let hatchLogs = contents
                .filter { $0.lastPathComponent.hasPrefix("hatch-") && $0.pathExtension == "log" }
                .sorted { a, b in
                    let aDate = (try? a.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                    let bDate = (try? b.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                    return aDate > bDate
                }

            for hatchLog in hatchLogs.prefix(3) {
                guard totalBytes < fallbackLogSizeLimit else { break }
                guard let attrs = try? fileManager.attributesOfItem(atPath: hatchLog.path),
                      let size = attrs[.size] as? Int,
                      size > 0 else { continue }

                let bytesToRead = min(size, fallbackLogSizeLimit - totalBytes)
                if bytesToRead >= size {
                    try? fileManager.copyItem(
                        at: hatchLog,
                        to: fallbackDir.appendingPathComponent(hatchLog.lastPathComponent)
                    )
                } else {
                    copyTail(
                        of: hatchLog,
                        bytes: bytesToRead,
                        to: fallbackDir.appendingPathComponent(hatchLog.lastPathComponent)
                    )
                }
                totalBytes += bytesToRead
            }
        }

        // 3. XDG CLI hatch log — ~/.config/vellum/logs/hatch.log
        //    Already collected under xdg-logs/ by the main export path, but verify
        //    it exists and include in the fallback directory for completeness.
        let xdgConfigHome = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
            ?? URL(fileURLWithPath: home).appendingPathComponent(".config").path
        let xdgHatchLog = URL(fileURLWithPath: xdgConfigHome)
            .appendingPathComponent("vellum/logs/hatch.log")
        if fileManager.fileExists(atPath: xdgHatchLog.path),
           totalBytes < fallbackLogSizeLimit,
           let attrs = try? fileManager.attributesOfItem(atPath: xdgHatchLog.path),
           let size = attrs[.size] as? Int,
           size > 0 {
            let bytesToRead = min(size, fallbackLogSizeLimit - totalBytes)
            if bytesToRead >= size {
                try? fileManager.copyItem(
                    at: xdgHatchLog,
                    to: fallbackDir.appendingPathComponent("xdg-hatch.log")
                )
            } else {
                copyTail(
                    of: xdgHatchLog,
                    bytes: bytesToRead,
                    to: fallbackDir.appendingPathComponent("xdg-hatch.log")
                )
            }
            totalBytes += bytesToRead
        }

        log.info("Collected \(totalBytes) bytes of fallback daemon logs from filesystem")
    }

    /// Reads the last `bytes` bytes from `source` and writes them to `destination`.
    private nonisolated static func copyTail(of source: URL, bytes: Int, to destination: URL) {
        guard let handle = try? FileHandle(forReadingFrom: source) else { return }
        defer { try? handle.close() }

        let fileSize = handle.seekToEndOfFile()
        let offset = fileSize > UInt64(bytes) ? fileSize - UInt64(bytes) : 0
        handle.seek(toFileOffset: offset)
        let data = handle.readData(ofLength: bytes)
        try? data.write(to: destination)
    }

    /// Reads the first `bytes` bytes from `source` and writes them to `destination`.
    private nonisolated static func copyHead(of source: URL, bytes: Int, to destination: URL) {
        guard let handle = try? FileHandle(forReadingFrom: source) else { return }
        defer { try? handle.close() }

        let data = handle.readData(ofLength: bytes)
        try? data.write(to: destination)
    }

    // MARK: - Crash Report Collection

    /// Process names to match in DiagnosticReports filenames.
    /// macOS names crash files `<process>-<date>-<time>.<ext>` or
    /// `<process>_<date>-<time>_<host>.<ext>`. The match requires the
    /// process name to be followed by a separator (`-`, `_`, or `.`)
    /// to avoid false positives from unrelated processes whose names
    /// share a prefix (e.g. `bundle`, `nodekit`).
    private nonisolated static let crashReportProcessNames = [
        "bun",
        "node",
        "qdrant",
        "vellum-assistant",
    ]

    /// File extensions recognised as crash/hang reports.
    private nonisolated static let crashReportExtensions: Set<String> = ["ips", "crash", "spin"]

    /// Maximum total bytes to copy from crash reports.
    private nonisolated static let crashReportSizeLimit = 5 * 1024 * 1024 // 5 MB

    /// Collects recent macOS crash and hang reports for assistant-related
    /// processes from `~/Library/Logs/DiagnosticReports/`.
    /// Only files from the last 7 days that match known process names are
    /// included, capped at 5 MB total (newest first).
    private nonisolated static func collectCrashReports(
        into dest: URL,
        fileManager: FileManager
    ) {
        let home = NSHomeDirectory()
        let reportsDir = URL(fileURLWithPath: home)
            .appendingPathComponent("Library/Logs/DiagnosticReports", isDirectory: true)
        guard fileManager.fileExists(atPath: reportsDir.path) else { return }

        guard let contents = try? fileManager.contentsOfDirectory(
            at: reportsDir,
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        let cutoff = Date().addingTimeInterval(-7 * 24 * 60 * 60)

        // Filter to matching files, then sort newest-first
        let matching = contents
            .filter { url in
                guard crashReportExtensions.contains(url.pathExtension.lowercased()) else {
                    return false
                }
                let name = url.lastPathComponent
                guard crashReportProcessNames.contains(where: { processName in
                    guard name.hasPrefix(processName) else { return false }
                    guard let next = name.dropFirst(processName.count).first else { return false }
                    return next == "-" || next == "_" || next == "."
                }) else {
                    return false
                }
                guard let values = try? url.resourceValues(forKeys: [.contentModificationDateKey]),
                      let modDate = values.contentModificationDate,
                      modDate >= cutoff else {
                    return false
                }
                return true
            }
            .sorted { a, b in
                let aDate = (try? a.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                let bDate = (try? b.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                return aDate > bDate
            }

        guard !matching.isEmpty else { return }
        try? fileManager.createDirectory(at: dest, withIntermediateDirectories: true)

        var totalBytes = 0
        var collectedCount = 0
        for file in matching {
            guard totalBytes < crashReportSizeLimit else { break }
            guard let values = try? file.resourceValues(forKeys: [.fileSizeKey]),
                  let size = values.fileSize,
                  size > 0 else { continue }

            let bytesToRead = min(size, crashReportSizeLimit - totalBytes)
            if bytesToRead >= size {
                try? fileManager.copyItem(
                    at: file,
                    to: dest.appendingPathComponent(file.lastPathComponent)
                )
            } else {
                // Truncate oversized reports — read from the start to
                // preserve the header (process name, exception, crashed thread).
                copyHead(
                    of: file,
                    bytes: bytesToRead,
                    to: dest.appendingPathComponent(file.lastPathComponent)
                )
            }
            totalBytes += bytesToRead
            collectedCount += 1
        }

        log.info("Collected \(collectedCount) crash report(s) (\(totalBytes) bytes)")
    }

    // MARK: - Unified Log Export

    /// Exports recent entries from Apple's unified logging system (`os.Logger`)
    /// for this app's subsystem. Includes CLI audit trail, lifecycle events,
    /// and any other structured log output not written to files on disk.
    ///
    /// Uses `OSLogStore` to read entries from the last 24 hours. Falls back
    /// silently if the API is unavailable or the subsystem has no entries.
    private nonisolated static func collectUnifiedLog(to destination: URL) {
        do {
            let store = try OSLogStore(scope: .currentProcessIdentifier)
            let oneDayAgo = store.position(date: Date().addingTimeInterval(-86400))
            let subsystem = Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant"

            let entries = try store.getEntries(
                at: oneDayAgo,
                matching: NSPredicate(format: "subsystem == %@", subsystem)
            )

            var lines: [String] = []
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withFullDate, .withTime, .withFractionalSeconds, .withColonSeparatorInTime]

            for entry in entries {
                guard let logEntry = entry as? OSLogEntryLog else { continue }
                let ts = formatter.string(from: logEntry.date)
                let level: String
                switch logEntry.level {
                case .debug: level = "DEBUG"
                case .info: level = "INFO"
                case .notice: level = "NOTICE"
                case .error: level = "ERROR"
                case .fault: level = "FAULT"
                default: level = "OTHER"
                }
                lines.append("[\(ts)] [\(level)] [\(logEntry.category)] \(logEntry.composedMessage)")
            }

            guard !lines.isEmpty else { return }
            let content = lines.joined(separator: "\n")
            try content.write(to: destination, atomically: true, encoding: .utf8)
            log.info("Exported \(lines.count) unified log entries to os-log.txt")
        } catch {
            log.warning("Failed to export unified log: \(error.localizedDescription)")
        }
    }

    // MARK: - Platform Log Helpers

    /// Fetches logs from the platform API for managed assistants, downloads
    /// the tar.gz response, extracts it into `directory/platform-logs/`.
    /// Silently skips on any failure.
    private nonisolated static func fetchPlatformLogs(
        into directory: URL,
        assistantId: String,
        organizationId: String
    ) async {
        guard let token = SessionTokenManager.getToken() else {
            log.warning("No session token available — skipping platform log export")
            return
        }

        let baseURL = await MainActor.run { AuthService.shared.baseURL }

        guard let url = URL(string: "\(baseURL)/v1/assistants/\(assistantId)/logs/export/") else {
            log.warning("Failed to construct platform log export URL")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue(token, forHTTPHeaderField: "X-Session-Token")
        request.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200...299).contains(http.statusCode) else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                log.warning("Platform log export API failed with status \(status)")
                return
            }

            try await extractTarGzResponse(data: data, into: directory, subdirectory: "platform-logs")
        } catch {
            log.warning("Platform log export request failed: \(error.localizedDescription)")
        }
    }

    /// Writes tar.gz `data` to a temporary file and extracts it into
    /// `directory/<subdirectory>/` using `/usr/bin/tar`.
    /// Validates archive member paths before extraction to prevent path traversal.
    private nonisolated static func extractTarGzResponse(
        data: Data,
        into directory: URL,
        subdirectory: String
    ) async throws {
        let fileManager = FileManager.default
        let tarPath = fileManager.temporaryDirectory
            .appendingPathComponent("\(subdirectory)-\(UUID().uuidString).tar.gz")
        try data.write(to: tarPath)

        defer {
            try? fileManager.removeItem(at: tarPath)
        }

        // Validate archive contents — reject paths with ".." components or absolute paths
        try await validateTarContents(at: tarPath)

        let extractDir = directory.appendingPathComponent(subdirectory, isDirectory: true)
        try fileManager.createDirectory(at: extractDir, withIntermediateDirectories: true)

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
            process.arguments = [
                "xzf",
                tarPath.path,
                "-C", extractDir.path,
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

    /// Lists tar archive members and rejects any with path traversal (`..`) or absolute paths.
    private nonisolated static func validateTarContents(at tarPath: URL) async throws {
        let entries = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
            process.arguments = ["tzf", tarPath.path]

            let pipe = Pipe()
            process.standardOutput = pipe

            let errPipe = Pipe()
            process.standardError = errPipe

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
                return
            }

            // Drain both pipes concurrently to prevent deadlock.
            // Sequential reads can block if tar fills one pipe buffer (~64 KB)
            // while we're waiting on the other.
            nonisolated(unsafe) var stdoutData = Data()
            nonisolated(unsafe) var stderrData = Data()
            let group = DispatchGroup()

            group.enter()
            DispatchQueue.global(qos: .utility).async {
                stdoutData = pipe.fileHandleForReading.readDataToEndOfFile()
                group.leave()
            }

            group.enter()
            DispatchQueue.global(qos: .utility).async {
                stderrData = errPipe.fileHandleForReading.readDataToEndOfFile()
                group.leave()
            }

            group.wait()

            process.waitUntilExit()

            if process.terminationStatus == 0 {
                let output = String(data: stdoutData, encoding: .utf8) ?? ""
                continuation.resume(returning: output)
            } else {
                let stderr = String(data: stderrData, encoding: .utf8) ?? ""
                continuation.resume(throwing: ExportError.tarFailed("Failed to list archive: \(stderr)"))
            }
        }

        for entry in entries.split(separator: "\n") {
            let path = String(entry)
            if path.hasPrefix("/") {
                log.warning("Rejecting archive with absolute path: \(path)")
                throw ExportError.unsafeArchivePath(path)
            }
            let components = (path as NSString).pathComponents
            if components.contains("..") {
                log.warning("Rejecting archive with path traversal: \(path)")
                throw ExportError.unsafeArchivePath(path)
            }
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
            "sidebarExpanded",
            "windowZoomLevel",
            "collectUsageData",
            "sendDiagnostics",
            "ttsVoiceId",
            "selectedImageGenModel",
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

    /// Replaces a value with a presence flag: "(set)" if non-empty, "(empty)" otherwise.
    private nonisolated static func redactValue(_ val: Any?) -> String {
        if let str = val as? String { return str.isEmpty ? "(empty)" : "(set)" }
        return val == nil ? "(empty)" : "(set)"
    }

    /// Reads the workspace config.json and writes a sanitized copy with sensitive
    /// values replaced by presence flags. Falls back silently if unreadable.
    private nonisolated static func writeSanitizedWorkspaceConfig(to url: URL) {
        var config = WorkspaceConfigIO.read()
        guard !config.isEmpty else { return }

        // Strip API key values — preserve which providers have keys configured
        if var apiKeys = config["apiKeys"] as? [String: Any] {
            for key in apiKeys.keys {
                apiKeys[key] = redactValue(apiKeys[key])
            }
            config["apiKeys"] = apiKeys
        }

        // Strip ingress webhook secret
        if var ingress = config["ingress"] as? [String: Any],
           var webhook = ingress["webhook"] as? [String: Any] {
            webhook["secret"] = redactValue(webhook["secret"])
            ingress["webhook"] = webhook
            config["ingress"] = ingress
        }

        // Strip skill-level API keys and env vars
        if var skills = config["skills"] as? [String: Any],
           var entries = skills["entries"] as? [String: [String: Any]] {
            for name in entries.keys {
                var entry = entries[name]!
                if entry["apiKey"] != nil {
                    entry["apiKey"] = redactValue(entry["apiKey"])
                }
                if var env = entry["env"] as? [String: Any] {
                    for envKey in env.keys {
                        env[envKey] = redactValue(env[envKey])
                    }
                    entry["env"] = env
                }
                entries[name] = entry
            }
            skills["entries"] = entries
            config["skills"] = skills
        }

        // Strip Twilio accountSid
        if var twilio = config["twilio"] as? [String: Any] {
            twilio["accountSid"] = redactValue(twilio["accountSid"])
            config["twilio"] = twilio
        }

        // Strip MCP transport headers (SSE/streamable-http) and env vars (stdio)
        if var mcp = config["mcp"] as? [String: Any],
           var servers = mcp["servers"] as? [String: [String: Any]] {
            for name in servers.keys {
                var server = servers[name]!
                if var transport = server["transport"] as? [String: Any] {
                    if var headers = transport["headers"] as? [String: Any] {
                        for key in headers.keys {
                            headers[key] = redactValue(headers[key])
                        }
                        transport["headers"] = headers
                    }
                    if var env = transport["env"] as? [String: Any] {
                        for key in env.keys {
                            env[key] = redactValue(env[key])
                        }
                        transport["env"] = env
                    }
                    server["transport"] = transport
                }
                servers[name] = server
            }
            mcp["servers"] = servers
            config["mcp"] = mcp
        }

        guard let data = try? JSONSerialization.data(
            withJSONObject: config,
            options: [.prettyPrinted, .sortedKeys]
        ) else { return }
        try? data.write(to: url)
    }

    enum ExportError: LocalizedError {
        case noLogsFound
        case tarFailed(String)
        case unsafeArchivePath(String)

        var errorDescription: String? {
            switch self {
            case .noLogsFound:
                return "No log files were found to export."
            case .tarFailed(let detail):
                return "Failed to create archive: \(detail)"
            case .unsafeArchivePath(let path):
                return "Archive contains unsafe path: \(path)"
            }
        }
    }
}
