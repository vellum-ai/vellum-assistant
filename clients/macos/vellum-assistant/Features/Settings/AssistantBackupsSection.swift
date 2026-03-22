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

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Backups")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.contentDefault)

            if let backupPath = preUpdateBackupPath,
               FileManager.default.fileExists(atPath: backupPath) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("A backup was automatically created before the last update.")
                        .font(VFont.caption)
                        .foregroundStyle(VColor.contentSecondary)
                    HStack {
                        VButton(label: "Restore Pre-Update Data", style: .outlined) {
                            Task {
                                await performLocalRestore(URL(fileURLWithPath: backupPath))
                                preUpdateBackupPath = nil
                            }
                        }
                        VButton(label: "Dismiss", style: .text) {
                            preUpdateBackupPath = nil
                        }
                    }
                }
            }

            if assistant.isManaged || (assistant.isRemote && !assistant.isDocker) {
                managedBackupContent
            } else {
                localBackupContent
            }

            if let error = errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
            }

            if let success = successMessage {
                Text(success)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemPositiveStrong)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceOverlay)
        .frame(maxWidth: .infinity, alignment: .leading)
        .task {
            if assistant.isManaged || (assistant.isRemote && !assistant.isDocker) {
                await loadManagedBackupsQuietly()
            }
        }
    }

    // MARK: - Local Backup Content

    @ViewBuilder
    private var localBackupContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Export or restore assistant data as a .vbundle archive.")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
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
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }
        }
    }

    // MARK: - Managed Backup Content

    @ViewBuilder
    private var managedBackupContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Create and restore cloud backups for this assistant.")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
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
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
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
                .font(VFont.inputLabel)
                .foregroundColor(VColor.contentSecondary)

            ForEach(managedBackups, id: \.snapshotName) { backup in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(backup.snapshotName)
                            .font(VFont.mono)
                            .foregroundColor(VColor.contentDefault)
                            .lineLimit(1)
                        Text(backup.createdAt)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                    }
                    Spacer()
                    if backup.readyToUse {
                        VButton(label: "Restore", style: .outlined) {
                            pendingManagedRestore = backup
                            showingManagedRestoreConfirmation = true
                        }
                    } else {
                        Text("Not ready")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
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

    // MARK: - Helpers

    private func clearMessages() {
        errorMessage = nil
        successMessage = nil
    }
}

// MARK: - Local Restore

extension AssistantBackupsSection {
    func performLocalRestore(_ fileURL: URL) async {
        isImporting = true
        defer { isImporting = false }

        do {
            let fileData = try Data(contentsOf: fileURL)
            let response = try await GatewayHTTPClient.post(path: "migrations/import", body: fileData, timeout: 120)

            if response.isSuccess {
                if let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                   let success = json["success"] as? Bool, success {
                    successMessage = "Backup restored. Restarting assistant..."

                    // Auto-restart the assistant so restored state takes effect
                    let assistantName = assistant.assistantId
                    let isDocker = assistant.isDocker
                    Task {
                        if isDocker {
                            try? await AppDelegate.shared?.vellumCli.sleep(name: assistantName)
                        } else {
                            AppDelegate.shared?.vellumCli.stop(name: assistantName)
                        }
                        try? await Task.sleep(nanoseconds: 500_000_000)
                        try? await AppDelegate.shared?.vellumCli.wake(name: assistantName)
                        // Reload avatar after restart so the restored avatar is displayed
                        AvatarAppearanceManager.shared.reloadAvatar()
                    }
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
