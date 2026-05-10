import SwiftUI
import VellumAssistantShared

/// Full-window blocking overlay shown while a service group upgrade is in
/// progress. Grays out the UI and displays a modal card with a determinate
/// progress bar and live status updates streamed from the daemon via SSE.
///
/// The overlay is driven entirely by `GatewayConnectionManager`'s observable
/// properties (`isUpdateInProgress`, `updateStatusMessage`, `lastUpdateOutcome`,
/// `updateExpectedDowntimeSeconds`) which are set from SSE events in
/// `handleServerMessage`.
struct UpgradeProgressOverlay: View {
    var connectionManager: GatewayConnectionManager

    /// Timestamp when the progress animation started.
    @State private var progressStartDate: Date?
    /// Snapshot of progress at the moment the upgrade completed, used to
    /// animate the final ramp to 100%.
    @State private var progressAtCompletion: Double?
    /// Timestamp when the upgrade completed (success or failure via SSE).
    @State private var completionTime: Date?
    /// Captured estimated duration at progress start, so it survives the
    /// observable being cleared when the upgrade completes.
    @State private var capturedEstimatedDuration: TimeInterval = 60

    /// Whether to show the outcome card (success/failure) before auto-dismissing.
    @State private var showOutcome: Bool = false
    /// Auto-dismiss task for the success outcome.
    @State private var dismissTask: Task<Void, Never>?

    /// Fallback estimated duration when the daemon does not provide one.
    private let defaultEstimatedDuration: TimeInterval = 60

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
            .onAppear { startProgress() }
            .onChange(of: connectionManager.isUpdateInProgress) { _, inProgress in
                if !inProgress {
                    // Snapshot the current progress value so the bar can
                    // ease-out ramp to 100% from the current position.
                    if let start = progressStartDate {
                        let elapsed = max(0, Date().timeIntervalSince(start))
                        progressAtCompletion = 0.95 * (1.0 - exp(-elapsed / capturedEstimatedDuration))
                        completionTime = Date()
                    }

                    withAnimation(VAnimation.standard) {
                        showOutcome = true
                    }

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
                    startProgress()
                }
            }
        }
    }

    // MARK: - Progress Card

    private var progressCard: some View {
        VStack(spacing: VSpacing.lg) {
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

            progressBar

            if let status = connectionManager.updateStatusMessage {
                Text(status)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .multilineTextAlignment(.center)
                    .animation(VAnimation.fast, value: connectionManager.updateStatusMessage)
            }
        }
        .padding(VSpacing.xxl)
        .frame(minWidth: 320)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .vShadow(VShadow.modalNear)
        .vShadow(VShadow.modalFar)
    }

    // MARK: - Determinate Progress Bar

    private var progressBar: some View {
        TimelineView(.animation) { context in
            let progress = progressValue(at: context.date)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(VColor.surfaceBase)
                        .frame(height: 6)
                    Capsule()
                        .fill(VColor.primaryBase)
                        .frame(width: geo.size.width * progress, height: 6)
                }
            }
            .frame(height: 6)
            .widthCap(200)
            .accessibilityElement()
            .accessibilityValue("\(Int(progress * 100)) percent")
            .accessibilityLabel("Upgrade progress")
        }
    }

    // MARK: - Progress Computation

    /// Computes progress using an asymptotic curve based on elapsed time and
    /// estimated duration. Called at display refresh rate via `TimelineView`.
    ///
    /// The formula `0.95 * (1 - e^(-t / estimate))` ensures the bar always
    /// appears to move but never reaches 100% until the upgrade actually
    /// completes. On completion, an ease-out ramp fills to 100%.
    private func progressValue(at date: Date) -> Double {
        guard let startDate = progressStartDate else { return 0 }

        // Upgrade completed — ease-out ramp from snapshot to 100%
        if let compTime = completionTime, let baseProgress = progressAtCompletion {
            let timeSinceCompletion = date.timeIntervalSince(compTime)
            let rampProgress = min(1.0, 1.0 - exp(-timeSinceCompletion * 3.0))
            return baseProgress + (1.0 - baseProgress) * rampProgress
        }

        // Asymptotic time-based progress: never reaches 95% no matter how long,
        // so the bar always appears to be moving.
        let elapsed = max(0, date.timeIntervalSince(startDate))
        return 0.95 * (1.0 - exp(-elapsed / capturedEstimatedDuration))
    }

    private func startProgress() {
        capturedEstimatedDuration = connectionManager.updateExpectedDowntimeSeconds ?? defaultEstimatedDuration
        progressStartDate = Date()
        progressAtCompletion = nil
        completionTime = nil
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
}
