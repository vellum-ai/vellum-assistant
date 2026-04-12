import AppKit
import Foundation
import SwiftUI
import VellumAssistantShared

/// Backup and restore UI for the Settings Account tab.
///
/// For local assistants, creates/restores `.vbundle` archives via the gateway's
/// migration endpoints (`POST /v1/migrations/export` and `POST /v1/migrations/import`).
///
/// For managed/remote assistants, uses the platform API endpoints
/// (`GET/POST /v1/assistants/{id}/backups`, `POST /v1/assistants/{id}/backups/{name}/restore`).
@MainActor
struct AssistantBackupsSection: View {
    let assistant: LockfileAssistant
    let store: SettingsStore

    @State private var isExporting = false
    @State private var isImporting = false
    @State private var errorMessage: String?
    @State private var successMessage: String?

    @AppStorage("preUpdateBackupPath") private var preUpdateBackupPath: String?

    // Managed assistant state
    @State private var managedBackups: [ManagedBackup] = []
    @State private var isLoadingBackups = false
    @State private var isCreatingBackup = false
    @State private var showingManagedRestoreConfirmation = false
    @State private var pendingManagedRestore: ManagedBackup?

    // Automatic backups state — populated by `loadAutoBackups()`.
    @State private var autoBackupsEnabled: Bool = false
    @State private var autoBackupsIntervalHours: Int = 6
    @State private var localSnapshots: [AutoBackupEntry] = []
    @State private var offsiteGroups: [OffsiteGroup] = []
    @State private var offsiteEnabled: Bool = true
    @State private var nextRunAt: Date? = nil
    @State private var isLoadingAutoBackups: Bool = false
    @State private var showingManageDestinationsSheet: Bool = false
    @State private var showingAutoBackupRestoreConfirmation: Bool = false
    @State private var pendingAutoRestoreURL: URL? = nil

    // `SettingsClient` is a stateless struct; construct fresh instances at
    // each call site inside async methods so Swift strict-concurrency sees
    // them as locally-owned rather than captured from `self`.

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Backups")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)

            if let backupPath = preUpdateBackupPath,
               FileManager.default.fileExists(atPath: backupPath) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("A backup was automatically created before the last update.")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    HStack {
                        VButton(label: "Restore Pre-Update Data", style: .outlined) {
                            Task {
                                await performLocalRestore(URL(fileURLWithPath: backupPath))
                                preUpdateBackupPath = nil
                            }
                        }
                        VButton(label: "Dismiss", style: .ghost) {
                            preUpdateBackupPath = nil
                        }
                    }
                }
            }

            if assistant.isManaged || (assistant.isRemote && !assistant.isDocker) {
                managedBackupContent
            } else {
                autoBackupsSubsection
                SettingsDivider()
                localBackupContent
            }

            if let error = errorMessage {
                Text(error)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }

            if let success = successMessage {
                Text(success)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemPositiveStrong)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
        .frame(maxWidth: .infinity, alignment: .leading)
        .task {
            if assistant.isManaged || (assistant.isRemote && !assistant.isDocker) {
                await loadManagedBackupsQuietly()
            } else {
                await loadAutoBackups()
            }
        }
        .sheet(isPresented: $showingManageDestinationsSheet) {
            ManageBackupDestinationsSheet(
                destinations: offsiteGroups.map { $0.destination },
                onSave: { newDestinations in
                    Task { await persistDestinations(newDestinations) }
                }
            )
        }
        .alert("Restore from Snapshot", isPresented: $showingAutoBackupRestoreConfirmation) {
            Button("Cancel", role: .cancel) { pendingAutoRestoreURL = nil }
            Button("Restore", role: .destructive) {
                if let url = pendingAutoRestoreURL {
                    pendingAutoRestoreURL = nil
                    Task { await performLocalRestore(url) }
                }
            }
        } message: {
            Text("This will replace the assistant's current data with the selected snapshot and restart it. This action cannot be undone.")
        }
    }

    // MARK: - Automatic Backups Subsection

    @ViewBuilder
    private var autoBackupsSubsection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Automatic backups")
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentDefault)

            Text("Periodically snapshot the workspace to a local directory and any configured offsite destinations.")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)

            VToggle(
                isOn: Binding(
                    get: { autoBackupsEnabled },
                    set: { newValue in
                        Task { await setAutoBackupsEnabled(newValue) }
                    }
                ),
                label: "Enable automatic backups",
                helperText: nil
            )
            .accessibilityLabel("Enable automatic backups")

            if autoBackupsEnabled {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Interval")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)

                    VDropdown(
                        placeholder: "Select interval",
                        selection: Binding(
                            get: { autoBackupsIntervalHours },
                            set: { newValue in
                                Task { await setAutoBackupsInterval(newValue) }
                            }
                        ),
                        options: [
                            (label: "Every 6 hours", value: 6),
                            (label: "Every 12 hours", value: 12),
                            (label: "Every 24 hours", value: 24),
                        ]
                    )
                    .frame(maxWidth: 260, alignment: .leading)
                }

                Text(nextRunDescription)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }

            if isLoadingAutoBackups {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading backups…")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }

            if autoBackupsEnabled {
                if !localSnapshots.isEmpty {
                    localSnapshotsCard
                }

                if offsiteEnabled {
                    ForEach(offsiteGroups) { group in
                        offsiteGroupCard(group)
                    }

                    HStack {
                        VButton(label: "Manage destinations…", style: .outlined) {
                            showingManageDestinationsSheet = true
                        }
                        Spacer()
                    }
                } else {
                    Text("Offsite backups are disabled.")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
        }
    }

    /// Human-readable "next scheduled" text derived from `nextRunAt`.
    private var nextRunDescription: String {
        guard let nextRunAt else {
            return "Next scheduled: not yet scheduled"
        }
        let now = Date()
        let interval = nextRunAt.timeIntervalSince(now)
        if interval <= 0 {
            return "Next scheduled: due now"
        }
        let totalMinutes = Int(interval / 60)
        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60
        if hours > 0 && minutes > 0 {
            return "Next scheduled: in \(hours)h \(minutes)m"
        }
        if hours > 0 {
            return "Next scheduled: in \(hours)h"
        }
        if minutes > 0 {
            return "Next scheduled: in \(minutes)m"
        }
        return "Next scheduled: in under a minute"
    }

    @ViewBuilder
    private var localSnapshotsCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Local snapshots")
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentSecondary)

            ForEach(localSnapshots) { entry in
                snapshotRow(entry)
            }
        }
        .padding(VSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceBase)
        )
    }

    @ViewBuilder
    private func offsiteGroupCard(_ group: OffsiteGroup) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                Text(displayPath(group.destination.path))
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer()

                if group.destination.encrypt {
                    Text("Encrypted")
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.systemPositiveStrong)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xxs)
                        .background(
                            Capsule().fill(VColor.systemPositiveWeak)
                        )
                } else {
                    Text("Plaintext")
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.systemMidStrong)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xxs)
                        .background(
                            Capsule().fill(VColor.systemMidWeak)
                        )
                }

                if group.reachable {
                    Text("Reachable")
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.systemPositiveStrong)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xxs)
                        .background(
                            Capsule().fill(VColor.systemPositiveWeak)
                        )
                } else {
                    Text("Unavailable")
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.systemNegativeStrong)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xxs)
                        .background(
                            Capsule().fill(VColor.systemNegativeWeak)
                        )
                }
            }

            if group.reachable {
                if group.snapshots.isEmpty {
                    Text("No snapshots yet")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                } else {
                    ForEach(group.snapshots) { entry in
                        snapshotRow(entry)
                    }
                }
            } else {
                Text(unreachableDescription(for: group.destination.path))
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
        .padding(VSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceBase)
        )
    }

    @ViewBuilder
    private func snapshotRow(_ entry: AutoBackupEntry) -> some View {
        HStack(spacing: VSpacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(Self.snapshotDateFormatter.string(from: entry.createdAt))
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                Text("\(Self.formatBytes(entry.sizeBytes)) · \(entry.filename)")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer()

            VButton(label: "Restore", style: .outlined) {
                pendingAutoRestoreURL = URL(fileURLWithPath: entry.path)
                showingAutoBackupRestoreConfirmation = true
            }
            .disabled(isImporting)
        }
        .padding(.vertical, VSpacing.xs)
    }

    /// Abbreviate a home-relative path for display (e.g. `~/iCloud/Backups`).
    private func displayPath(_ path: String) -> String {
        (path as NSString).abbreviatingWithTildeInPath
    }

    /// Short, user-facing explanation for why an offsite destination is
    /// unreachable. Uses path hints to guess between iCloud / external drive.
    private func unreachableDescription(for path: String) -> String {
        let lower = path.lowercased()
        if lower.contains("/mobile documents/") || lower.contains("icloud") {
            return "iCloud Drive is not available."
        }
        if lower.hasPrefix("/volumes/") {
            return "External drive is not mounted."
        }
        return "Destination is not currently available."
    }

    private static let snapshotDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    /// Format a byte count as a short human-readable string.
    private static func formatBytes(_ bytes: Int64) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        let kb = Double(bytes) / 1024
        if kb < 1024 { return String(format: "%.1f KB", kb) }
        let mb = kb / 1024
        if mb < 1024 { return String(format: "%.1f MB", mb) }
        let gb = mb / 1024
        return String(format: "%.2f GB", gb)
    }

    // MARK: - Local Backup Content

    @ViewBuilder
    private var localBackupContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Export or restore assistant data as a .vbundle archive.")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }

        HStack(spacing: VSpacing.md) {
            VButton(label: isExporting ? "Exporting..." : "Create Backup", style: .outlined) {
                Task { await exportLocalBackup() }
            }
            .disabled(isExporting || isImporting)

            VButton(label: isImporting ? "Restoring..." : "Restore from Backup", style: .outlined) {
                selectAndRestoreLocalBackup()
            }
            .disabled(isExporting || isImporting)
        }

        if isExporting || isImporting {
            HStack(spacing: VSpacing.sm) {
                ProgressView()
                    .controlSize(.small)
                Text(isExporting ? "Creating backup..." : "Restoring backup...")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    // MARK: - Managed Backup Content

    @ViewBuilder
    private var managedBackupContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Create and restore cloud backups for this assistant.")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }

        HStack(spacing: VSpacing.md) {
            VButton(label: isCreatingBackup ? "Creating..." : "Create Backup", style: .outlined) {
                Task { await createManagedBackup() }
            }
            .disabled(isCreatingBackup || isLoadingBackups)

            VButton(label: isLoadingBackups ? "Loading..." : "Refresh", style: .outlined) {
                Task { await loadManagedBackups() }
            }
            .disabled(isLoadingBackups || isCreatingBackup)
        }

        if isLoadingBackups || isCreatingBackup {
            HStack(spacing: VSpacing.sm) {
                ProgressView()
                    .controlSize(.small)
                Text(isCreatingBackup ? "Creating backup..." : "Loading backups...")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }

        if !managedBackups.isEmpty {
            managedBackupList
        }
    }

    @ViewBuilder
    private var managedBackupList: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Available Backups")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)

            ForEach(managedBackups, id: \.snapshotName) { backup in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(backup.snapshotName)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentDefault)
                            .lineLimit(1)
                        Text(backup.createdAt)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                    Spacer()
                    if backup.readyToUse {
                        VButton(label: "Restore", style: .outlined) {
                            pendingManagedRestore = backup
                            showingManagedRestoreConfirmation = true
                        }
                    } else {
                        Text("Not ready")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                }
                .padding(.vertical, VSpacing.xs)
            }
        }
        .alert("Restore Backup", isPresented: $showingManagedRestoreConfirmation) {
            Button("Cancel", role: .cancel) {
                pendingManagedRestore = nil
            }
            Button("Restore", role: .destructive) {
                if let backup = pendingManagedRestore {
                    Task { await restoreManagedBackup(backup) }
                }
            }
        } message: {
            Text("This will restore the assistant from the selected backup. Current data will be replaced. The assistant will be briefly unavailable.")
        }
    }

    // MARK: - Local Backup Actions

    private func exportLocalBackup() async {
        clearMessages()
        isExporting = true
        defer { isExporting = false }

        do {
            let response = try await GatewayHTTPClient.post(path: "migrations/export", timeout: 120)

            guard response.isSuccess else {
                errorMessage = "Export failed (HTTP \(response.statusCode))"
                return
            }

            // Generate a timestamped filename (Content-Disposition header is not
            // available through GatewayHTTPClient.Response).
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd-HHmmss"
            let filename = "export-\(formatter.string(from: Date())).vbundle"

            // Show save panel — don't set allowedContentTypes since the filename
            // already includes .vbundle; setting it causes NSSavePanel to append
            // a duplicate extension (.vbundle.vbundle).
            let panel = NSSavePanel()
            panel.nameFieldStringValue = filename
            panel.canCreateDirectories = true

            let panelResult = await panel.beginSheetModal(for: NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first!)
            guard panelResult == .OK, let saveURL = panel.url else { return }

            try response.data.write(to: saveURL)
            successMessage = "Backup saved to \(saveURL.lastPathComponent)"
        } catch let error as GatewayHTTPClient.ClientError {
            errorMessage = error.localizedDescription
        } catch {
            errorMessage = "Export failed: \(error.localizedDescription)"
        }
    }

    private func selectAndRestoreLocalBackup() {
        clearMessages()

        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.init(filenameExtension: "vbundle") ?? .data]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false

        panel.begin { result in
            Task { @MainActor in
                guard result == .OK, let url = panel.url else { return }

                // Use NSAlert instead of SwiftUI .alert — SwiftUI alerts on
                // inner views are swallowed when the parent has its own .alert
                // modifiers (SettingsDeveloperTab has several).
                let alert = NSAlert()
                alert.messageText = "Restore from Backup"
                alert.informativeText = "This will replace the assistant's current data with the backup and restart it. This action cannot be undone."
                alert.alertStyle = .warning
                alert.addButton(withTitle: "Restore")
                alert.addButton(withTitle: "Cancel")
                alert.buttons.first?.hasDestructiveAction = true

                let response = alert.runModal()
                guard response == .alertFirstButtonReturn else { return }

                await performLocalRestore(url)
            }
        }
    }

    // MARK: - Managed Backup Actions

    private func loadManagedBackups() async {
        clearMessages()
        await loadManagedBackupsQuietly()
    }

    /// Fetches managed backups without clearing existing messages.
    private func loadManagedBackupsQuietly() async {
        isLoadingBackups = true
        defer { isLoadingBackups = false }

        do {
            let (decoded, _): (ManagedBackupsResponse?, _) = try await GatewayHTTPClient.get(
                path: "assistants/\(assistant.assistantId)/backups"
            )
            guard let decoded else {
                errorMessage = "Failed to load backups"
                return
            }
            managedBackups = decoded.backups
        } catch let error as GatewayHTTPClient.ClientError {
            errorMessage = error.localizedDescription
        } catch {
            errorMessage = "Failed to load backups: \(error.localizedDescription)"
        }
    }

    private func createManagedBackup() async {
        clearMessages()
        isCreatingBackup = true
        defer { isCreatingBackup = false }

        do {
            let response = try await GatewayHTTPClient.post(path: "assistants/\(assistant.assistantId)/backups")
            if response.isSuccess {
                successMessage = "Backup created successfully"
                await loadManagedBackupsQuietly()
                // Clear any error from the backups fetch so it doesn't appear alongside the success
                if successMessage != nil { errorMessage = nil }
            } else {
                errorMessage = "Failed to create backup (HTTP \(response.statusCode))"
            }
        } catch let error as GatewayHTTPClient.ClientError {
            errorMessage = error.localizedDescription
        } catch {
            errorMessage = "Failed to create backup: \(error.localizedDescription)"
        }
    }

    private func restoreManagedBackup(_ backup: ManagedBackup) async {
        clearMessages()
        isLoadingBackups = true
        defer {
            isLoadingBackups = false
            pendingManagedRestore = nil
        }

        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/\(assistant.assistantId)/backups/\(backup.snapshotName)/restore"
            )
            if response.isSuccess {
                successMessage = "Restore initiated. The assistant may be briefly unavailable."
            } else {
                errorMessage = "Restore failed (HTTP \(response.statusCode))"
            }
        } catch let error as GatewayHTTPClient.ClientError {
            errorMessage = error.localizedDescription
        } catch {
            errorMessage = "Restore failed: \(error.localizedDescription)"
        }
    }

    // MARK: - Automatic Backup Actions

    /// Fetch `/v1/backups` plus the raw `config.backup.*` fields and refresh
    /// all automatic-backup state in one shot.
    private func loadAutoBackups() async {
        isLoadingAutoBackups = true
        defer { isLoadingAutoBackups = false }

        do {
            // Raw GET so the decoder configuration stays on-actor. The typed
            // overload on `GatewayHTTPClient.get<T>` is convenient but its
            // `configure` closure parameter is not `@Sendable`, which conflicts
            // with strict concurrency when called from @MainActor code.
            let response = try await GatewayHTTPClient.get(path: "backups", timeout: 15)
            guard response.isSuccess else {
                errorMessage = "Failed to load backups (HTTP \(response.statusCode))"
                return
            }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let decoded: BackupListResponseDTO
            do {
                decoded = try decoder.decode(BackupListResponseDTO.self, from: response.data)
            } catch {
                errorMessage = "Failed to parse backup list: \(error.localizedDescription)"
                return
            }

            localSnapshots = decoded.local
            offsiteGroups = decoded.offsite
            offsiteEnabled = decoded.offsiteEnabled
            nextRunAt = decoded.nextRunAt

            // Pull `backup.enabled` / `backup.intervalHours` from the daemon
            // config so the toggle and picker reflect the real on-disk state.
            let client = SettingsClient()
            if let config = await client.fetchConfig(),
               let backupConfig = config["backup"] as? [String: Any] {
                if let enabled = backupConfig["enabled"] as? Bool {
                    autoBackupsEnabled = enabled
                }
                if let intervalHours = backupConfig["intervalHours"] as? Int {
                    autoBackupsIntervalHours = intervalHours
                } else if let intervalDouble = backupConfig["intervalHours"] as? Double {
                    autoBackupsIntervalHours = Int(intervalDouble)
                }
            }
        } catch let error as GatewayHTTPClient.ClientError {
            errorMessage = error.localizedDescription
        } catch {
            errorMessage = "Failed to load backups: \(error.localizedDescription)"
        }
    }

    /// Persist `backup.enabled` and refetch so subsequent UI reflects the
    /// new scheduling state.
    private func setAutoBackupsEnabled(_ enabled: Bool) async {
        clearMessages()
        // Optimistically update so the toggle feels responsive; the refetch
        // below confirms the change.
        autoBackupsEnabled = enabled
        let client = SettingsClient()
        let success = await client.patchConfig([
            "backup": ["enabled": enabled]
        ])
        if !success {
            errorMessage = "Failed to update automatic backups setting"
            // Roll back the optimistic change on failure.
            autoBackupsEnabled = !enabled
            return
        }
        await loadAutoBackups()
    }

    /// Persist `backup.intervalHours` and refetch the backup list.
    private func setAutoBackupsInterval(_ hours: Int) async {
        clearMessages()
        let previous = autoBackupsIntervalHours
        autoBackupsIntervalHours = hours
        let client = SettingsClient()
        let success = await client.patchConfig([
            "backup": ["intervalHours": hours]
        ])
        if !success {
            errorMessage = "Failed to update backup interval"
            autoBackupsIntervalHours = previous
            return
        }
        await loadAutoBackups()
    }

    /// Replace `backup.offsite.destinations` wholesale from the manage-
    /// destinations sheet.
    private func persistDestinations(_ destinations: [BackupDestinationDTO]) async {
        clearMessages()
        let payload: [[String: Any]] = destinations.map { dest in
            ["path": dest.path, "encrypt": dest.encrypt]
        }
        let client = SettingsClient()
        let success = await client.patchConfig([
            "backup": ["offsite": ["destinations": payload]]
        ])
        if !success {
            errorMessage = "Failed to update backup destinations"
            return
        }
        await loadAutoBackups()
    }

    // MARK: - Helpers

    private func clearMessages() {
        errorMessage = nil
        successMessage = nil
    }
}

// MARK: - Local Restore

extension AssistantBackupsSection {
    /// Restore from a local `.vbundle` or `.vbundle.enc` file.
    ///
    /// Dispatches to one of two daemon endpoints based on the file's extension:
    ///
    /// - `.vbundle.enc` → `POST /v1/backups/restore` with a JSON `{ path }` body.
    ///   The daemon auto-detects the `.enc` suffix, loads the backup key from
    ///   the protected directory, and decrypts the bundle in place. This path
    ///   only works for files that already live inside a configured backup
    ///   directory (local or offsite) — symlink escapes are rejected by the
    ///   daemon's `validateSnapshotPath` check.
    ///
    /// - `.vbundle` (plain) → `POST /v1/migrations/import` with the raw bytes.
    ///   This preserves the existing behaviour for user-selected files from
    ///   the file picker and for the pre-update backup prompt, where the
    ///   file may live outside any configured backup directory.
    ///
    /// Both branches surface the same success/error messages and trigger the
    /// same assistant auto-restart on success.
    func performLocalRestore(_ fileURL: URL) async {
        isImporting = true
        defer { isImporting = false }

        if fileURL.path.hasSuffix(".vbundle.enc") {
            await performSnapshotPathRestore(fileURL.path)
        } else {
            await performVbundleUploadRestore(fileURL)
        }
    }

    /// Restore an encrypted `.vbundle.enc` snapshot via the daemon's
    /// path-based `/v1/backups/restore` endpoint.
    private func performSnapshotPathRestore(_ path: String) async {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "backups/restore",
                json: ["path": path],
                timeout: 120
            )
            if response.isSuccess {
                handleRestoreSuccess(message: "Backup restored. Restarting assistant...")
            } else {
                let detail = Self.extractErrorMessage(from: response.data)
                errorMessage = detail ?? "Restore failed (HTTP \(response.statusCode))"
            }
        } catch let error as GatewayHTTPClient.ClientError {
            errorMessage = error.localizedDescription
        } catch {
            errorMessage = "Restore failed: \(error.localizedDescription)"
        }
    }

    /// Restore a plaintext `.vbundle` file by uploading its bytes to the
    /// daemon's `/v1/migrations/import` endpoint. Preserves backwards
    /// compatibility with the pre-update backup prompt and the manual file
    /// picker flow.
    private func performVbundleUploadRestore(_ fileURL: URL) async {
        do {
            let fileData = try Data(contentsOf: fileURL)
            let response = try await GatewayHTTPClient.post(
                path: "migrations/import",
                body: fileData,
                contentType: "application/octet-stream",
                timeout: 120
            )

            if response.isSuccess {
                if let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                   let success = json["success"] as? Bool, success {
                    handleRestoreSuccess(message: "Backup restored. Restarting assistant...")
                } else {
                    errorMessage = "Import completed with warnings. Check assistant logs for details."
                }
            } else if response.statusCode == 413 {
                errorMessage = "Backup file is too large. Please upgrade the assistant to restore this backup."
            } else {
                errorMessage = "Import failed (HTTP \(response.statusCode))"
            }
        } catch let error as GatewayHTTPClient.ClientError {
            errorMessage = error.localizedDescription
        } catch {
            errorMessage = "Import failed: \(error.localizedDescription)"
        }
    }

    /// Shared post-restore handler: show a success message and trigger the
    /// assistant restart so the restored state takes effect.
    private func handleRestoreSuccess(message: String) {
        successMessage = message

        // Auto-restart the assistant so restored state takes effect
        let assistantName = assistant.assistantId
        let isDocker = assistant.isDocker
        Task {
            if isDocker {
                try? await AppDelegate.shared?.vellumCli.sleep(name: assistantName)
            } else {
                await AppDelegate.shared?.vellumCli.stop(name: assistantName)
            }
            try? await Task.sleep(nanoseconds: 500_000_000)
            try? await AppDelegate.shared?.vellumCli.wake(name: assistantName)
            // Reload avatar after restart so the restored avatar is displayed
            AvatarAppearanceManager.shared.reloadAvatar()
        }
    }

    /// Try to extract a human-readable error message from a JSON error body.
    /// Falls back to `nil` when the body does not parse or does not contain a
    /// recognisable message field.
    private static func extractErrorMessage(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        if let error = json["error"] as? [String: Any], let message = error["message"] as? String {
            return message
        }
        if let error = json["error"] as? String {
            return error
        }
        return nil
    }
}

// MARK: - Managed Backup Models

struct ManagedBackup: Decodable, Identifiable {
    let snapshotName: String
    let pvc: String
    let createdAt: String
    let readyToUse: Bool
    let backupType: String

    var id: String { snapshotName }

    private enum CodingKeys: String, CodingKey {
        case snapshotName = "snapshot_name"
        case pvc
        case createdAt = "created_at"
        case readyToUse = "ready_to_use"
        case backupType = "backup_type"
    }
}

private struct ManagedBackupsResponse: Decodable {
    let backups: [ManagedBackup]
}

// MARK: - Automatic Backup Models

/// A single backup snapshot as reported by `GET /v1/backups`.
struct AutoBackupEntry: Identifiable, Decodable, Equatable {
    var id: String { path }
    let path: String
    let filename: String
    let createdAt: Date
    let sizeBytes: Int64
    let encrypted: Bool
}

/// An offsite destination group with its snapshots and reachability status.
struct OffsiteGroup: Identifiable, Decodable, Equatable {
    var id: String { destination.path }
    let destination: BackupDestinationDTO
    let snapshots: [AutoBackupEntry]
    let reachable: Bool
}

/// Mirrors the daemon's `BackupDestination` schema: an absolute path plus
/// an encryption flag.
struct BackupDestinationDTO: Decodable, Equatable, Identifiable {
    var id: String { path }
    let path: String
    let encrypt: Bool
}

/// Shape of the `GET /v1/backups` response, decoded with an ISO8601 strategy
/// so `createdAt` and `nextRunAt` arrive as `Date` values.
///
/// `offsiteEnabled` distinguishes "offsite disabled" (user turned it off — UI
/// should hide offsite cards) from "offsite enabled but no destinations
/// configured" (`offsite` is empty but the UI should prompt to add one).
/// Older daemons that predate this field default `offsiteEnabled` to `true`
/// on decode so the UI keeps rendering offsite cards the way it used to.
struct BackupListResponseDTO: Decodable {
    let local: [AutoBackupEntry]
    let offsite: [OffsiteGroup]
    let offsiteEnabled: Bool
    let nextRunAt: Date?

    private enum CodingKeys: String, CodingKey {
        case local
        case offsite
        case offsiteEnabled
        case nextRunAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        local = try container.decode([AutoBackupEntry].self, forKey: .local)
        offsite = try container.decode([OffsiteGroup].self, forKey: .offsite)
        // Default to `true` for pre-offsiteEnabled daemons so the UI keeps
        // rendering offsite cards instead of silently hiding them.
        offsiteEnabled = try container.decodeIfPresent(Bool.self, forKey: .offsiteEnabled) ?? true
        nextRunAt = try container.decodeIfPresent(Date.self, forKey: .nextRunAt)
    }
}

// MARK: - Manage Destinations Sheet

/// Lightweight list-based editor for `backup.offsite.destinations`. Users can
/// add a new destination (file dialog), remove existing entries, or toggle
/// encryption on each destination. Changes are committed to config.json via
/// the `onSave` callback when the user taps "Save".
@MainActor
private struct ManageBackupDestinationsSheet: View {
    let onSave: ([BackupDestinationDTO]) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var destinations: [BackupDestinationDTO]

    init(destinations: [BackupDestinationDTO], onSave: @escaping ([BackupDestinationDTO]) -> Void) {
        self._destinations = State(initialValue: destinations)
        self.onSave = onSave
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Manage Destinations")
                    .font(.headline)
                Spacer()
                Button("Add…") { addDestination() }
                Button("Done") {
                    onSave(destinations)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding()

            SettingsDivider()

            if destinations.isEmpty {
                VStack(spacing: VSpacing.sm) {
                    Text("No offsite destinations configured.")
                        .foregroundStyle(VColor.contentSecondary)
                    Text("Add a destination to replicate backups outside your workspace.")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding()
            } else {
                List {
                    ForEach(destinations) { destination in
                        destinationRow(destination)
                    }
                }
            }
        }
        .frame(width: 520, height: 420)
    }

    @ViewBuilder
    private func destinationRow(_ destination: BackupDestinationDTO) -> some View {
        HStack(spacing: VSpacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text((destination.path as NSString).abbreviatingWithTildeInPath)
                    .font(VFont.bodyMediumDefault)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(destination.encrypt ? "Encrypted" : "Plaintext")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            Spacer()
            Button(destination.encrypt ? "Disable encryption" : "Enable encryption") {
                toggleEncrypt(for: destination)
            }
            Button("Remove", role: .destructive) {
                remove(destination)
            }
        }
        .padding(.vertical, VSpacing.xs)
    }

    private func addDestination() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        panel.message = "Select a directory to replicate backups to."
        panel.begin { result in
            Task { @MainActor in
                guard result == .OK, let url = panel.url else { return }
                let path = url.path
                // Avoid duplicate entries for the same path.
                guard !destinations.contains(where: { $0.path == path }) else { return }
                destinations.append(BackupDestinationDTO(path: path, encrypt: true))
            }
        }
    }

    private func toggleEncrypt(for destination: BackupDestinationDTO) {
        guard let index = destinations.firstIndex(where: { $0.id == destination.id }) else { return }
        destinations[index] = BackupDestinationDTO(
            path: destination.path,
            encrypt: !destination.encrypt
        )
    }

    private func remove(_ destination: BackupDestinationDTO) {
        destinations.removeAll { $0.id == destination.id }
    }
}
