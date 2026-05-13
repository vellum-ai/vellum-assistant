import SwiftUI
import VellumAssistantShared

@MainActor
struct ProComputeUpgradeSection: View {
    let assistantId: String
    let subscription: SubscriptionResponse?
    let onUpgradeComplete: () -> Void

    @State var machineSize: String? = nil
    @State var isLoadingMachineSize: Bool = true
    @State var showConfirmation: Bool = false
    @State var isUpgrading: Bool = false
    @State var upgradeError: String? = nil

    var isPro: Bool { subscription?.plan_id == "pro" }
    // Only show when the platform has explicitly persisted "small" — nil means either "never persisted" or "fetch failed", and we can't distinguish, so play it safe.
    var needsUpgrade: Bool { machineSize == "small" }
    var shouldShowCard: Bool { isPro && !isLoadingMachineSize && needsUpgrade }

    var body: some View {
        Group {
            if shouldShowCard {
                upgradeCard
            }
        }
        .task(id: "\(assistantId):\(subscription?.plan_id ?? "")") {
            isLoadingMachineSize = true
            guard isPro else {
                isLoadingMachineSize = false
                return
            }
            let detail = await AssistantClient.fetchDetail(assistantId: assistantId)
            guard !Task.isCancelled else { return }
            machineSize = detail?.machine_size
            isLoadingMachineSize = false
        }
        .onChange(of: assistantId) { _, _ in
            showConfirmation = false
            upgradeError = nil
        }
    }

    private var upgradeCard: some View {
        SettingsCard(
            title: "Compute Profile",
            subtitle: "Your Pro plan includes a larger compute profile with more CPU and memory."
        ) {
            HStack(spacing: VSpacing.sm) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Current")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    Text("Small")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                }

                VIconView(.chevronRight, size: 14)
                    .foregroundStyle(VColor.contentTertiary)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Available")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    Text("Medium (Pro)")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentEmphasized)
                }

                Spacer()

                if showConfirmation {
                    VButton(
                        label: "Cancel",
                        style: .ghost,
                        isDisabled: isUpgrading
                    ) {
                        showConfirmation = false
                    }
                }

                VButton(
                    label: showConfirmation ? "Confirm Upgrade" : "Upgrade Compute",
                    style: showConfirmation ? .primary : .outlined,
                    isDisabled: isUpgrading
                ) {
                    if showConfirmation {
                        Task { await performUpgrade() }
                    } else {
                        upgradeError = nil
                        showConfirmation = true
                    }
                }
            }

            if showConfirmation {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.triangleAlert, size: 13)
                        .foregroundStyle(VColor.systemMidStrong)
                    Text("Your assistant will be briefly unreachable while it restarts with the new compute profile.")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.systemMidStrong)
                }
            }

            if let upgradeError {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.circleAlert, size: 13)
                        .foregroundStyle(VColor.systemNegativeStrong)
                    Text(upgradeError)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.systemNegativeStrong)
                }
            }
        }
    }

    private func performUpgrade() async {
        guard !isUpgrading else { return }
        let targetId = assistantId
        isUpgrading = true
        upgradeError = nil
        defer { isUpgrading = false }

        let (success, detail) = await AssistantClient.proUpgradeMachine(assistantId: targetId)
        guard targetId == assistantId else { return }
        if success {
            // Optimistically dismiss before the re-fetch — a stale GET that still
            // returns "small" must not regress the card back into view.
            machineSize = "medium"
            if let refreshed = await AssistantClient.fetchDetail(assistantId: targetId),
               let actual = refreshed.machine_size,
               actual != "small",
               targetId == assistantId {
                machineSize = actual
            }
            showConfirmation = false
            onUpgradeComplete()
        } else {
            upgradeError = detail ?? "Failed to upgrade compute profile. Please try again."
        }
    }
}

// MARK: - Test Support

#if DEBUG
extension ProComputeUpgradeSection {
    init(
        assistantId: String,
        subscription: SubscriptionResponse?,
        initialMachineSize: String?,
        initialIsLoading: Bool,
        onUpgradeComplete: @escaping () -> Void = {}
    ) {
        self.assistantId = assistantId
        self.subscription = subscription
        self.onUpgradeComplete = onUpgradeComplete
        self._machineSize = State(initialValue: initialMachineSize)
        self._isLoadingMachineSize = State(initialValue: initialIsLoading)
    }
}
#endif
