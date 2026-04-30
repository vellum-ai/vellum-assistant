import SwiftUI
import VellumAssistantShared

/// Full-window blocking overlay shown while a service group upgrade is in
/// progress. Grays out the UI and displays a modal card with live status
/// updates streamed from the daemon via SSE.
///
/// The overlay is driven entirely by `GatewayConnectionManager`'s observable
/// properties (`isUpdateInProgress`, `updateStatusMessage`, `lastUpdateOutcome`)
/// which are set from SSE events in `handleServerMessage`.
struct UpgradeProgressOverlay: View {
    var connectionManager: GatewayConnectionManager

    /// Tracks elapsed seconds since the overlay appeared.
    @State private var elapsedSeconds: Int = 0
    @State private var timerTask: Task<Void, Never>?

    /// Whether to show the outcome card (success/failure) before auto-dismissing.
    @State private var showOutcome: Bool = false
    /// Auto-dismiss task for the success outcome.
    @State private var dismissTask: Task<Void, Never>?

    var body: some View {
        if connectionManager.isUpdateInProgress || showOutcome {
            ZStack {
                VColor.auxBlack.opacity(0.45)
                    .ignoresSafeArea()

                if showOutcome, let outcome = connectionManager.lastUpdateOutcome {
                    outcomeCard(outcome)
                        .transition(.opacity.combined(with: .scale(scale: 0.95)))
                } else {
                    progressCard
                        .transition(.opacity.combined(with: .scale(scale: 0.95)))
                }
            }
            .animation(VAnimation.standard, value: connectionManager.isUpdateInProgress)
            .animation(VAnimation.standard, value: showOutcome)
            .onAppear { startTimer() }
            .onDisappear { stopTimer() }
            .onChange(of: connectionManager.isUpdateInProgress) { _, inProgress in
                if !inProgress {
                    // Upgrade finished — show outcome briefly
                    withAnimation(VAnimation.standard) {
                        showOutcome = true
                    }
                    stopTimer()

                    // Auto-dismiss success after 3 seconds
                    if case .succeeded = connectionManager.lastUpdateOutcome?.result {
                        dismissTask = Task {
                            try? await Task.sleep(nanoseconds: 3_000_000_000)
                            guard !Task.isCancelled else { return }
                            withAnimation(VAnimation.standard) {
                                showOutcome = false
                            }
                            connectionManager.clearLastUpdateOutcome()
                        }
                    }
                } else {
                    // New upgrade starting
                    showOutcome = false
                    dismissTask?.cancel()
                    elapsedSeconds = 0
                    startTimer()
                }
            }
        }
    }

    // MARK: - Progress Card

    private var progressCard: some View {
        VStack(spacing: VSpacing.lg) {
            ProgressView()
                .controlSize(.large)
                .tint(VColor.primaryBase)

            VStack(spacing: VSpacing.sm) {
                Text("Upgrading Assistant")
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentEmphasized)

                if let target = connectionManager.updateTargetVersion {
                    Text("Updating to \(target)")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
            }

            if let status = connectionManager.updateStatusMessage {
                Text(status)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .multilineTextAlignment(.center)
                    .animation(VAnimation.fast, value: connectionManager.updateStatusMessage)
            }

            Text(formattedElapsed)
                .font(VFont.numericMono)
                .foregroundStyle(VColor.contentTertiary)
        }
        .padding(VSpacing.xxl)
        .frame(minWidth: 320)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .vShadow(VShadow.modalNear)
        .vShadow(VShadow.modalFar)
    }

    // MARK: - Outcome Card

    private func outcomeCard(_ outcome: UpdateOutcome) -> some View {
        VStack(spacing: VSpacing.lg) {
            outcomeIcon(outcome.result)

            VStack(spacing: VSpacing.sm) {
                Text(outcomeTitle(outcome.result))
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentEmphasized)

                Text(outcomeDetail(outcome.result))
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
            }

            if !isSuccessOutcome(outcome.result) {
                VButton(label: "Dismiss", style: .outlined, size: .regular) {
                    withAnimation(VAnimation.standard) {
                        showOutcome = false
                    }
                    connectionManager.clearLastUpdateOutcome()
                }
            }
        }
        .padding(VSpacing.xxl)
        .frame(minWidth: 320)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .vShadow(VShadow.modalNear)
        .vShadow(VShadow.modalFar)
    }

    // MARK: - Outcome Helpers

    @ViewBuilder
    private func outcomeIcon(_ result: UpdateOutcome.Result) -> some View {
        switch result {
        case .succeeded:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 40))
                .foregroundStyle(VColor.systemPositiveStrong)
        case .rolledBack:
            Image(systemName: "arrow.uturn.backward.circle.fill")
                .font(.system(size: 40))
                .foregroundStyle(VColor.systemMidStrong)
        case .timedOut:
            Image(systemName: "clock.badge.exclamationmark")
                .font(.system(size: 40))
                .foregroundStyle(VColor.systemMidStrong)
        case .failed:
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 40))
                .foregroundStyle(VColor.systemNegativeStrong)
        }
    }

    private func outcomeTitle(_ result: UpdateOutcome.Result) -> String {
        switch result {
        case .succeeded(let version):
            return "Updated to \(version)"
        case .rolledBack:
            return "Update Rolled Back"
        case .timedOut:
            return "Update Timed Out"
        case .failed:
            return "Update Failed"
        }
    }

    private func outcomeDetail(_ result: UpdateOutcome.Result) -> String {
        switch result {
        case .succeeded:
            return "Your assistant is ready."
        case .rolledBack(let from, let to):
            return "Reverted from \(from) to \(to). Your data is safe."
        case .timedOut:
            return "The update is taking longer than expected. Check Settings for status."
        case .failed:
            return "Something went wrong. Your previous version has been preserved."
        }
    }

    private func isSuccessOutcome(_ result: UpdateOutcome.Result) -> Bool {
        if case .succeeded = result { return true }
        return false
    }

    // MARK: - Timer

    private var formattedElapsed: String {
        let minutes = elapsedSeconds / 60
        let seconds = elapsedSeconds % 60
        return String(format: "%d:%02d", minutes, seconds)
    }

    private func startTimer() {
        timerTask?.cancel()
        elapsedSeconds = 0
        timerTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else { break }
                elapsedSeconds += 1
            }
        }
    }

    private func stopTimer() {
        timerTask?.cancel()
        timerTask = nil
    }
}
