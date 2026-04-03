import SwiftUI
import VellumAssistantShared

/// Popover panel displaying the two-axis permission mode toggles.
///
/// - **Ask before acting** — when on the assistant checks in before high-stakes actions.
/// - **Computer access** — when on the assistant can run commands on the host machine.
///
/// Toggles send `PUT /v1/permission-mode` and update immediately on the SSE response.
/// The view is feature-flag gated on `permission-controls-v2`.
struct PermissionModeStatusView: View {
    @ObservedObject var connectionManager: GatewayConnectionManager
    private let permissionModeClient: any PermissionModeClientProtocol = PermissionModeClient()

    private var askBeforeActing: Bool {
        connectionManager.permissionMode?.askBeforeActing ?? PermissionModeDefaults.askBeforeActing
    }

    private var hostAccess: Bool {
        connectionManager.permissionMode?.hostAccess ?? PermissionModeDefaults.hostAccess
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text("Permission Controls")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentEmphasized)

            toggleRow(
                label: "Ask before acting",
                subtitle: askBeforeActing
                    ? "Checks in before high-stakes actions"
                    : "Acts autonomously",
                isOn: askBeforeActing,
                icon: askBeforeActing ? .shieldCheck : .shieldOff
            ) {
                updateMode(askBeforeActing: !askBeforeActing)
            }

            toggleRow(
                label: "Computer access",
                subtitle: hostAccess
                    ? "Can run commands on your computer"
                    : "Cannot access your computer",
                isOn: hostAccess,
                icon: hostAccess ? .terminal : .lock
            ) {
                updateMode(hostAccess: !hostAccess)
            }
        }
        .padding(VSpacing.lg)
        .frame(width: 280)
    }

    // MARK: - Toggle Row

    @ViewBuilder
    private func toggleRow(
        label: String,
        subtitle: String,
        isOn: Bool,
        icon: VIcon,
        onToggle: @escaping () -> Void
    ) -> some View {
        HStack(spacing: VSpacing.md) {
            VIconView(icon, size: 16)
                .foregroundStyle(isOn ? VColor.systemPositiveStrong : VColor.contentSecondary)

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(label)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)

                Text(subtitle)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }

            Spacer()

            Toggle("", isOn: Binding(
                get: { isOn },
                set: { _ in onToggle() }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
            .controlSize(.small)
            .tint(VColor.systemPositiveStrong)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .accessibilityValue(isOn ? "On" : "Off")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onToggle() }
    }

    // MARK: - Network

    private func updateMode(askBeforeActing: Bool? = nil, hostAccess: Bool? = nil) {
        Task {
            _ = await permissionModeClient.updatePermissionMode(
                askBeforeActing: askBeforeActing,
                hostAccess: hostAccess
            )
            // State update arrives via SSE `permission_mode_update` event,
            // which updates connectionManager.permissionMode automatically.
        }
    }
}
