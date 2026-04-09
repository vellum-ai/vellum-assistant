import Foundation
import SwiftUI
import VellumAssistantShared

/// Backup and restore UI for the General settings tab.
///
/// Only rendered for cloud-hosted (platform-managed) assistants — the call site
/// in `SettingsGeneralTab` gates this section on `LockfileAssistant.isManaged`.
/// Uses the platform API endpoints (`GET/POST /v1/assistants/{id}/backups`,
/// `POST /v1/assistants/{id}/backups/{name}/restore`).
///
/// Pre-update local recovery for non-managed assistants lives in
/// `PreUpdateBackupBanner` and is rendered separately above this section.
@MainActor
struct AssistantBackupsSection: View {
    let assistant: LockfileAssistant
    let store: SettingsStore

    @State private var errorMessage: String?
    @State private var successMessage: String?

    @State private var managedBackups: [ManagedBackup] = []
    @State private var isLoadingBackups = false
    @State private var isCreatingBackup = false
    @State private var showingManagedRestoreConfirmation = false
    @State private var pendingManagedRestore: ManagedBackup?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Backups")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)

            managedBackupContent

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
            await loadManagedBackupsQuietly()
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
