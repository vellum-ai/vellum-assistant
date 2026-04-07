import Foundation
import os
import SwiftUI
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "Teleport")

// MARK: - Teleport Destination

private enum TeleportDestination {
    case docker
    case platform

    var displayLabel: String {
        switch self {
        case .docker:
            return "Move to Docker"
        case .platform:
            return "Move to Cloud (Platform)"
        }
    }

    var description: String {
        switch self {
        case .docker:
            return "Run your assistant in a Docker container on this Mac."
        case .platform:
            return "Run your assistant in the cloud, managed by the Vellum platform."
        }
    }

    /// The CLI flag value for `--<targetEnv>`.
    var cliFlag: String {
        switch self {
        case .docker: return "docker"
        case .platform: return "platform"
        }
    }
}

// MARK: - Teleport Phase

private enum TeleportPhase {
    case idle
    case transferring(step: String)
    case verifying
    case failed(error: String)
}

// MARK: - TeleportSection View

/// Teleport UI for moving an assistant between hosting environments without retiring the source.
///
/// Unlike `AssistantTransferSection`, teleport preserves the source assistant until the user
/// explicitly confirms the new one works. After transfer, a verification banner lets the user
/// either confirm (and retire the old assistant) or restore back to the original.
///
/// The actual export → hatch → import flow is delegated to the CLI's `vellum teleport` command.
/// The desktop only manages the UI state, confirmation, and post-teleport assistant switch.
@MainActor
struct TeleportSection: View {
    let assistant: LockfileAssistant
    let onClose: () -> Void

    @State private var phase: TeleportPhase = .idle
    @State private var showingConfirmation = false
    @State private var pendingDestination: TeleportDestination?
    @State private var transferTask: Task<Void, Never>?
    @State private var originalAssistant: LockfileAssistant?
    @State private var targetAssistant: LockfileAssistant?

    var body: some View {
        Group {
            if assistant.isManaged || (assistant.isRemote && !assistant.isDocker) {
                EmptyView()
            } else {
                teleportContent
            }
        }
        .alert(confirmationTitle, isPresented: $showingConfirmation) {
            Button("Cancel", role: .cancel) {
                pendingDestination = nil
            }
            Button("Teleport", role: .destructive) {
                guard let destination = pendingDestination else { return }
                originalAssistant = assistant
                transferTask = Task { await executeTeleport(to: destination) }
            }
        } message: {
            Text(confirmationMessage)
        }
        .onDisappear {
            transferTask?.cancel()
        }
    }

    private var confirmationTitle: String {
        pendingDestination?.displayLabel ?? "Teleport"
    }

    private var confirmationMessage: String {
        "Your data will be copied to the new environment. The current assistant will remain available until you confirm the new one works."
    }

    // MARK: - Content

    @ViewBuilder
    private var teleportContent: some View {
        SettingsCard(title: "Teleport", subtitle: "Move your assistant to a different hosting environment") {
            if case .verifying = phase {
                verifyingBanner
            } else if case .transferring(let step) = phase {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text(step)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            } else if case .failed(let error) = phase {
                failedBanner(error: error)
            } else {
                destinationPicker
            }
        }
    }

    // MARK: - Destination Picker

    @ViewBuilder
    private var destinationPicker: some View {
        if assistant.cloud.lowercased() == "local" || assistant.isDocker {
            destinationButton(for: .platform)
        }
    }

    @ViewBuilder
    private func destinationButton(for destination: TeleportDestination) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(destination.description)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)

            VButton(
                label: destination.displayLabel,
                style: .outlined,
                isDisabled: isDestinationDisabled(destination)
            ) {
                pendingDestination = destination
                showingConfirmation = true
            }

            if destination == .platform && SessionTokenManager.getToken() == nil {
                Text("Sign in to move to cloud.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    private func isDestinationDisabled(_ destination: TeleportDestination) -> Bool {
        if case .idle = phase {} else { return true }
        if destination == .platform && SessionTokenManager.getToken() == nil {
            return true
        }
        return false
    }

    // MARK: - Verifying Banner

    @ViewBuilder
    private var verifyingBanner: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack(spacing: VSpacing.sm) {
                VIconView(.circleCheck, size: 16)
                    .foregroundStyle(VColor.systemPositiveStrong)
                Text("Transfer complete — verify your new assistant is working.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDefault)
            }

            HStack(spacing: VSpacing.sm) {
                VButton(
                    label: "Confirm & Switch",
                    style: .primary
                ) {
                    confirmAndSwitch()
                }

                VButton(
                    label: "Cancel",
                    style: .outlined
                ) {
                    cancelTeleport()
                }
            }
        }
    }

    // MARK: - Failed Banner

    @ViewBuilder
    private func failedBanner(error: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text(error)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.systemNegativeStrong)

            VButton(
                label: "Try Again",
                style: .outlined
            ) {
                phase = .idle
            }
        }
    }

    // MARK: - Confirm & Cancel

    private func confirmAndSwitch() {
        guard let target = targetAssistant else { return }
        let original = originalAssistant

        // Switch to the new assistant (this destroys the window)
        AppDelegate.shared?.performSwitchAssistant(to: target)

        // Fire-and-forget retirement of the old assistant via CLI
        if let original {
            let oldId = original.assistantId
            Task {
                do {
                    try await AppDelegate.shared?.vellumCli.retire(name: oldId)
                    log.info("[teleport] Retired assistant \(oldId, privacy: .public)")
                } catch {
                    log.error("[teleport] Failed to retire assistant \(oldId, privacy: .public): \(error.localizedDescription, privacy: .public)")
                }
            }
        }

        onClose()
    }

    private func cancelTeleport() {
        // Retire or sleep the target assistant to clean up
        if let target = targetAssistant {
            let targetId = target.assistantId
            Task {
                do {
                    if target.isDocker {
                        try await AppDelegate.shared?.vellumCli.sleep(name: targetId)
                        log.info("[teleport] Slept Docker assistant \(targetId, privacy: .public) after cancel")
                    } else {
                        try await AppDelegate.shared?.vellumCli.retire(name: targetId)
                        log.info("[teleport] Retired assistant \(targetId, privacy: .public) after cancel")
                    }
                } catch {
                    log.error("[teleport] Failed to clean up assistant \(targetId, privacy: .public): \(error.localizedDescription, privacy: .public)")
                }
            }
        }
        phase = .idle
        targetAssistant = nil
    }

    // MARK: - Transfer Execution (CLI delegation)

    /// Delegates the teleport to the CLI's `vellum teleport` command.
    ///
    /// Uses `--keep-source` so the source assistant is preserved until the user
    /// explicitly confirms via the verification banner. The CLI handles export,
    /// hatch, import, and lockfile updates internally.
    private func executeTeleport(to destination: TeleportDestination) async {
        phase = .transferring(step: "Preparing...")

        // Snapshot assistant IDs before teleport so we can diff afterward
        let assistantIdsBefore = Set(LockfileAssistant.loadAll().map(\.assistantId))
        let sourceName = assistant.assistantId

        do {
            try await AppDelegate.shared?.vellumCli.teleport(
                from: sourceName,
                targetEnv: destination.cliFlag,
                keepSource: true,
                onOutput: { line in
                    Task { @MainActor in
                        phase = .transferring(step: line)
                    }
                }
            )

            // Discover the new assistant by diffing the lockfile
            let assistantsAfter = LockfileAssistant.loadAll()
            let newAssistant = assistantsAfter.first(where: { !assistantIdsBefore.contains($0.assistantId) })

            guard let resolvedTarget = newAssistant else {
                // Fallback: the CLI may have reused an existing assistant.
                // Look for the active assistant that isn't the source.
                let activeId = LockfileAssistant.loadActiveAssistantId()
                let fallback = assistantsAfter.first(where: { $0.assistantId == activeId && $0.assistantId != sourceName })
                guard let fallbackTarget = fallback else {
                    throw VellumCli.CLIError.executionFailed("Teleport completed but could not identify the new assistant in the lockfile.")
                }
                targetAssistant = fallbackTarget
                transferTask = nil
                phase = .verifying
                return
            }

            targetAssistant = resolvedTarget
            transferTask = nil
            phase = .verifying
        } catch {
            phase = .failed(error: "Teleport failed: \(error.localizedDescription)")
        }
    }
}
