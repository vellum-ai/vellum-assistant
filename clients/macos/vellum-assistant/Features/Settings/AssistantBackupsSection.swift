import AppKit
import Foundation
import SwiftUI
import VellumAssistantShared

/// Backup and restore UI for the Settings Account tab.
///
/// For local assistants, creates/restores `.vbundle` archives via the assistant's
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
    @State private var showingRestoreConfirmation = false
    @State private var pendingRestoreURL: URL?
    @State private var errorMessage: String?
    @State private var successMessage: String?

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

            if assistant.isManaged || assistant.isRemote {
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
            if assistant.isManaged || assistant.isRemote {
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

        let port = assistant.resolvedDaemonPort()
        let token = ActorTokenManager.getToken()

        guard let url = URL(string: "http://localhost:\(port)/v1/migrations/export") else {
            errorMessage = "Invalid assistant URL"
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                errorMessage = "Invalid response from assistant"
                return
            }

            guard httpResponse.statusCode == 200 else {
                errorMessage = "Export failed (HTTP \(httpResponse.statusCode))"
                return
            }

            // Extract filename from Content-Disposition header, or generate one
            let filename: String
            if let disposition = httpResponse.value(forHTTPHeaderField: "Content-Disposition"),
               let nameMatch = disposition.range(of: "filename=\"", options: .caseInsensitive),
               let endQuote = disposition[nameMatch.upperBound...].firstIndex(of: "\"") {
                filename = String(disposition[nameMatch.upperBound..<endQuote])
            } else {
                let formatter = DateFormatter()
                formatter.dateFormat = "yyyy-MM-dd-HHmmss"
                filename = "export-\(formatter.string(from: Date())).vbundle"
            }

            // Show save panel
            let panel = NSSavePanel()
            panel.nameFieldStringValue = filename
            panel.allowedContentTypes = [.init(filenameExtension: "vbundle") ?? .data]
            panel.canCreateDirectories = true

            let panelResult = await panel.beginSheetModal(for: NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first!)
            guard panelResult == .OK, let saveURL = panel.url else { return }

            try data.write(to: saveURL)
            successMessage = "Backup saved to \(saveURL.lastPathComponent)"
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
            guard result == .OK, let url = panel.url else { return }
            Task { @MainActor in
                pendingRestoreURL = url
                showingRestoreConfirmation = true
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

// MARK: - Local Restore Confirmation Modifier

extension AssistantBackupsSection {
    /// Attaches the restore confirmation alert. Called from the parent view so the alert
    /// scope covers the entire card.
    var withRestoreConfirmation: some View {
        self.alert("Restore from Backup", isPresented: $showingRestoreConfirmation) {
            Button("Cancel", role: .cancel) {
                pendingRestoreURL = nil
            }
            Button("Restore", role: .destructive) {
                if let url = pendingRestoreURL {
                    Task { await performLocalRestore(url) }
                }
            }
        } message: {
            Text("This will replace the assistant's current data with the backup and restart it. This action cannot be undone.")
        }
    }

    private func performLocalRestore(_ fileURL: URL) async {
        isImporting = true
        defer { isImporting = false }

        let port = assistant.resolvedDaemonPort()
        let token = ActorTokenManager.getToken()

        guard let url = URL(string: "http://localhost:\(port)/v1/migrations/import") else {
            errorMessage = "Invalid assistant URL"
            return
        }

        do {
            let fileData = try Data(contentsOf: fileURL)

            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 60
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            if let token, !token.isEmpty {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            request.httpBody = fileData

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                errorMessage = "Invalid response from assistant"
                return
            }

            if httpResponse.statusCode == 200 {
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let success = json["success"] as? Bool, success {
                    successMessage = "Backup restored. Restarting assistant..."

                    // Auto-restart the assistant so restored state takes effect
                    let assistantName = assistant.assistantId
                    Task {
                        AppDelegate.shared?.assistantCli.stop(name: assistantName)
                        try? await Task.sleep(nanoseconds: 500_000_000)
                        try? await AppDelegate.shared?.assistantCli.wake(name: assistantName)
                    }
                } else {
                    errorMessage = "Import completed with warnings. Check assistant logs for details."
                }
            } else {
                errorMessage = "Import failed (HTTP \(httpResponse.statusCode))"
            }
        } catch {
            errorMessage = "Import failed: \(error.localizedDescription)"
        }

        pendingRestoreURL = nil
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
