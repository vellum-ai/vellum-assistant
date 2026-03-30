import SwiftUI
import VellumAssistantShared

// MARK: - Maintenance Mode Banner

/// Inline banner shown when the connected managed assistant is in maintenance mode.
///
/// The banner identifies the debug pod that currently has the workspace PVC mounted
/// and provides two recovery actions:
///  - **Resume Assistant** — exits maintenance mode via the platform API.
///  - **Open SSH Settings** — navigates to the Developer settings tab where the
///    SSH terminal and maintenance controls live.
///
/// Uses the same visual pattern as `CreditsExhaustedBanner` and `MissingApiKeyBanner`:
/// anchored at the bottom of the message list, above the composer.
struct MaintenanceModeBanner: View {
    /// The current maintenance-mode payload. The banner is only visible when
    /// `maintenanceMode.enabled == true`.
    let maintenanceMode: PlatformAssistantMaintenanceMode

    /// Invoked when the user taps "Resume Assistant". Should call
    /// `SettingsStore.exitManagedAssistantMaintenanceMode()`.
    let onResumeAssistant: () -> Void

    /// Invoked when the user taps "Open SSH Settings". Should navigate to the
    /// Developer settings tab.
    let onOpenSSHSettings: () -> Void

    /// `true` while an exit-maintenance-mode request is in flight.
    var isExiting: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack(alignment: .top, spacing: VSpacing.sm) {
                VIconView(.triangleAlert, size: 14)
                    .foregroundStyle(VColor.systemMidStrong)
                    .padding(.top, 1)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Assistant in Maintenance Mode")
                        .font(VFont.bodySmallEmphasised)
                        .foregroundStyle(VColor.contentEmphasized)

                    if let podName = maintenanceMode.debug_pod_name, !podName.isEmpty {
                        Text("Debug pod \(podName) has the workspace mounted.")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentSecondary)
                    } else {
                        Text("Your assistant workspace is currently mounted by a debug pod.")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentSecondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack(spacing: VSpacing.sm) {
                VButton(
                    label: isExiting ? "Resuming…" : "Resume Assistant",
                    style: .primary
                ) {
                    onResumeAssistant()
                }
                .disabled(isExiting)
                .accessibilityLabel(isExiting ? "Resuming assistant" : "Resume assistant")

                VButton(label: "Open SSH Settings", style: .outlined) {
                    onOpenSSHSettings()
                }
                .accessibilityLabel("Open SSH settings")
            }
        }
        .padding(VSpacing.lg)
        .background(VColor.surfaceActive)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: VRadius.lg,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: VRadius.lg
            )
        )
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .accessibilityElement(children: .contain)
    }
}
