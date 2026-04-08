import AppKit
import Foundation
import SwiftUI
import VellumAssistantShared

/// Banner that surfaces a pre-update `.vbundle` backup created automatically
/// by Sparkle's `onWillInstallUpdate` hook (see `AppDelegate+ConnectionSetup`).
///
/// Visible to all assistant types — local users are the primary consumers of
/// pre-update recovery, so this view is rendered outside of `AssistantBackupsSection`
/// (which is gated on managed/cloud assistants only). The banner only renders
/// when `preUpdateBackupPath` is set in defaults and the file still exists on
/// disk; otherwise it's a no-op.
@MainActor
struct PreUpdateBackupBanner: View {
    let assistant: LockfileAssistant?

    @AppStorage("preUpdateBackupPath") private var preUpdateBackupPath: String?

    @State private var isImporting = false
    @State private var errorMessage: String?
    @State private var successMessage: String?

    var body: some View {
        if let backupPath = preUpdateBackupPath,
           FileManager.default.fileExists(atPath: backupPath) {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Pre-Update Backup")
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)

                Text("A backup was automatically created before the last update.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)

                HStack {
                    VButton(
                        label: isImporting ? "Restoring..." : "Restore Pre-Update Data",
                        style: .outlined
                    ) {
                        Task {
                            await performLocalRestore(URL(fileURLWithPath: backupPath))
                            preUpdateBackupPath = nil
                        }
                    }
                    .disabled(isImporting)
                    VButton(label: "Dismiss", style: .ghost) {
                        preUpdateBackupPath = nil
                    }
                    .disabled(isImporting)
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
        }
    }

    /// Restores the assistant from a `.vbundle` backup via the gateway's
    /// `migrations/import` endpoint, then bounces the daemon so the restored
    /// state takes effect.
    private func performLocalRestore(_ fileURL: URL) async {
        isImporting = true
        defer { isImporting = false }

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
                    successMessage = "Backup restored. Restarting assistant..."

                    // Auto-restart the assistant so restored state takes effect.
                    if let assistant {
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
                            // Reload avatar after restart so the restored avatar is displayed.
                            AvatarAppearanceManager.shared.reloadAvatar()
                        }
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
