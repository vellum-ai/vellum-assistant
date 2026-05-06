import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ProComputeUpgradeSection")

/// Inline upgrade card prompting Pro subscribers to migrate their managed
/// assistant to the larger compute profile that ships with the Pro plan.
///
/// The card only renders when:
/// - the user holds an active Pro subscription (`subscription.plan_id == "pro"`),
/// - the assistant's admin detail has loaded, and
/// - the assistant is still on the default `small` machine size (or the field
///   is `nil`, meaning the platform hasn't recorded one yet — treat as small).
///
/// The admin-detail fetch is intentionally gated on `isPro` so non-Pro users
/// never trigger the network call.
@MainActor
struct ProComputeUpgradeSection: View {
    let assistantId: String
    let subscription: SubscriptionResponse?
    let onUpgradeComplete: () -> Void

    /// Closure-injected so tests can substitute fakes without touching the
    /// network. Defaults wire through the production `AdminAssistantClient`.
    var fetchDetail: (String) async -> AdminAssistantDetailResponse? = AdminAssistantClient.fetchDetail
    var proUpgradeMachine: (String) async throws -> (Bool, String?) = AdminAssistantClient.proUpgradeMachine

    @State var machineSize: String? = nil
    @State var isLoadingMachineSize: Bool = true
    @State var showConfirmation: Bool = false
    @State var isUpgrading: Bool = false
    @State var upgradeError: String? = nil

    var isPro: Bool { subscription?.plan_id == "pro" }
    var needsUpgrade: Bool { machineSize == nil || machineSize == "small" }
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
            let detail = await fetchDetail(assistantId)
            machineSize = detail?.machine_size
            isLoadingMachineSize = false
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
        isUpgrading = true
        upgradeError = nil
        defer {
            isUpgrading = false
            showConfirmation = false
        }

        do {
            let (success, detail) = try await proUpgradeMachine(assistantId)
            if success {
                // Server confirmed the upgrade — optimistically dismiss the CTA so a
                // flaky re-fetch can't regress the card back into the visible state.
                machineSize = "medium"
                if let refreshed = await fetchDetail(assistantId), let actual = refreshed.machine_size {
                    machineSize = actual
                }
                onUpgradeComplete()
            } else {
                upgradeError = detail ?? "Failed to upgrade compute profile. Please try again."
            }
        } catch {
            log.error("proUpgradeMachine threw: \(error.localizedDescription, privacy: .public)")
            upgradeError = "Failed to upgrade compute profile. Please try again."
        }
    }
}

// MARK: - Test Support

#if DEBUG
extension ProComputeUpgradeSection {
    /// Test-only initializer that pre-populates `@State` so tests can assert
    /// on derived display properties without driving the `.task { ... }`
    /// network fetch. Mirrors the pattern in `SettingsBillingTab.init(...)`.
    init(
        assistantId: String,
        subscription: SubscriptionResponse?,
        initialMachineSize: String?,
        initialIsLoading: Bool,
        onUpgradeComplete: @escaping () -> Void = {},
        fetchDetail: @escaping (String) async -> AdminAssistantDetailResponse? = AdminAssistantClient.fetchDetail,
        proUpgradeMachine: @escaping (String) async throws -> (Bool, String?) = AdminAssistantClient.proUpgradeMachine
    ) {
        self.assistantId = assistantId
        self.subscription = subscription
        self.onUpgradeComplete = onUpgradeComplete
        self.fetchDetail = fetchDetail
        self.proUpgradeMachine = proUpgradeMachine
        self._machineSize = State(initialValue: initialMachineSize)
        self._isLoadingMachineSize = State(initialValue: initialIsLoading)
    }
}
#endif
