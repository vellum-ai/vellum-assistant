import Foundation
import os
import SwiftUI
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AssistantTransfer")

/// Transfer UI for moving an assistant between local and cloud (managed) hosting.
///
/// For local assistants, offers "Transfer to Cloud" which delegates to the CLI's
/// `vellum teleport --from <source> --platform` command, then switches the active
/// connection and retires the local assistant.
///
/// For managed assistants, offers "Transfer to Local" which delegates to the CLI's
/// `vellum teleport --from <source> --local` command, then switches the active
/// connection and retires the managed assistant.
///
/// The CLI handles the entire export → hatch → import flow internally. The desktop
/// only manages the UI state and post-teleport assistant switch.
@MainActor
struct AssistantTransferSection: View {
    let assistant: LockfileAssistant
    let onClose: () -> Void

    @State private var isTransferring = false
    @State private var currentStep: String?
    @State private var showingConfirmation = false
    @State private var showingManagedConfirmation = false
    @State private var errorMessage: String?
    @State private var transferTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Transfer")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)

            if !assistant.isManaged && !assistant.isRemote {
                localToManagedContent
            } else if assistant.isManaged {
                managedToLocalContent
            } else {
                EmptyView()
            }

            if isTransferring {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text(currentStep ?? "Transferring...")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }

            if let error = errorMessage {
                Text(error)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
        .alert("Transfer to Cloud", isPresented: $showingConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Transfer", role: .destructive) {
                transferTask = Task { await transferLocalToManaged() }
            }
        } message: {
            Text("This will move all conversations, memory, and settings to a cloud-hosted assistant, then retire the local one. This cannot be undone.")
        }
        .alert("Transfer to Local", isPresented: $showingManagedConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Transfer", role: .destructive) {
                transferTask = Task { await transferManagedToLocal() }
            }
        } message: {
            Text("This will move all conversations, memory, and settings to a local assistant on this Mac, then retire the cloud one. This cannot be undone.")
        }
        .onDisappear {
            transferTask?.cancel()
        }
    }

    // MARK: - Local → Managed Content

    @ViewBuilder
    private var localToManagedContent: some View {
        Text("Move your assistant and all its data to the cloud.")
            .font(VFont.labelDefault)
            .foregroundStyle(VColor.contentTertiary)

        VButton(
            label: isTransferring ? "Transferring..." : "Transfer to Cloud",
            style: .primary,
            isDisabled: isTransferring || SessionTokenManager.getToken() == nil
        ) {
            showingConfirmation = true
        }

        if SessionTokenManager.getToken() == nil {
            Text("Sign in to transfer your assistant to the cloud.")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
    }

    // MARK: - Managed → Local Content

    @ViewBuilder
    private var managedToLocalContent: some View {
        Text("Move your assistant and all its data to this Mac.")
            .font(VFont.labelDefault)
            .foregroundStyle(VColor.contentTertiary)

        VButton(
            label: isTransferring ? "Transferring..." : "Transfer to Local",
            style: .primary,
            isDisabled: isTransferring
        ) {
            showingManagedConfirmation = true
        }
    }

    // MARK: - Transfer Logic (CLI delegation)

    /// Transfers a local assistant to the cloud via `vellum teleport --from <source> --platform`.
    ///
    /// The CLI handles the entire export → hatch → import flow. After the CLI completes,
    /// the desktop discovers the new assistant from the lockfile, switches to it, and
    /// retires the source.
    private func transferLocalToManaged() async {
        isTransferring = true
        errorMessage = nil
        defer {
            isTransferring = false
            currentStep = nil
        }

        let sourceName = assistant.assistantId

        // Snapshot assistant IDs before teleport so we can diff afterward
        let assistantIdsBefore = Set(LockfileAssistant.loadAll().map(\.assistantId))

        do {
            currentStep = "Preparing teleport..."
            try await AppDelegate.shared?.vellumCli.teleport(
                from: sourceName,
                targetEnv: "platform",
                onOutput: { line in
                    Task { @MainActor in
                        currentStep = line
                    }
                }
            )

            // Discover the new assistant by diffing the lockfile
            currentStep = "Switching to cloud assistant..."
            let newAssistant = try discoverNewAssistant(
                assistantIdsBefore: assistantIdsBefore,
                sourceName: sourceName
            )

            AppDelegate.shared?.performSwitchAssistant(to: newAssistant)
            transferTask = nil
            onClose()
        } catch {
            errorMessage = "Transfer failed: \(error.localizedDescription)"
        }
    }

    /// Transfers a managed (cloud) assistant to local via `vellum teleport --from <source> --local`.
    ///
    /// The CLI handles the entire export → hatch → import flow. After the CLI completes,
    /// the desktop discovers the new assistant from the lockfile, switches to it, and
    /// retires the source.
    private func transferManagedToLocal() async {
        isTransferring = true
        errorMessage = nil
        defer {
            isTransferring = false
            currentStep = nil
        }

        let sourceName = assistant.assistantId

        // Snapshot assistant IDs before teleport so we can diff afterward
        let assistantIdsBefore = Set(LockfileAssistant.loadAll().map(\.assistantId))

        do {
            currentStep = "Preparing teleport..."
            try await AppDelegate.shared?.vellumCli.teleport(
                from: sourceName,
                targetEnv: "local",
                onOutput: { line in
                    Task { @MainActor in
                        currentStep = line
                    }
                }
            )

            // Discover the new assistant by diffing the lockfile
            currentStep = "Switching to local assistant..."
            let newAssistant = try discoverNewAssistant(
                assistantIdsBefore: assistantIdsBefore,
                sourceName: sourceName
            )

            AppDelegate.shared?.performSwitchAssistant(to: newAssistant)
            transferTask = nil
            onClose()
        } catch {
            errorMessage = "Transfer failed: \(error.localizedDescription)"
        }
    }

    // MARK: - Helpers

    /// Discovers the new assistant that the CLI created by diffing the lockfile
    /// against a pre-teleport snapshot.
    ///
    /// Falls back to checking `activeAssistant` if no new entry was added (the CLI
    /// may have reused an existing assistant).
    private func discoverNewAssistant(
        assistantIdsBefore: Set<String>,
        sourceName: String
    ) throws -> LockfileAssistant {
        let assistantsAfter = LockfileAssistant.loadAll()
        if let newAssistant = assistantsAfter.first(where: { !assistantIdsBefore.contains($0.assistantId) }) {
            return newAssistant
        }

        // Fallback: the CLI may have reused an existing assistant.
        // Look for the active assistant that isn't the source.
        let activeId = LockfileAssistant.loadActiveAssistantId()
        if let fallback = assistantsAfter.first(where: { $0.assistantId == activeId && $0.assistantId != sourceName }) {
            return fallback
        }

        throw VellumCli.CLIError.executionFailed("Transfer completed but could not identify the new assistant in the lockfile.")
    }
}
