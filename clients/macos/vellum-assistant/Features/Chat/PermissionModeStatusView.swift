import SwiftUI
import VellumAssistantShared

/// Popover panel displaying the two-axis permission mode toggles.
///
/// - **Ask before acting** — when on the assistant checks in before high-stakes actions.
/// - **Computer access** — when on the assistant can run commands on the host machine.
///
/// Toggles send `PUT /v1/permission-mode` and apply the successful response immediately.
/// SSE still reconciles follow-up updates from other clients.
/// The view is feature-flag gated on `permission-controls-v2`.
struct PermissionModeStatusView: View {
    @StateObject private var model: PermissionModeStatusModel

    init(
        connectionManager: GatewayConnectionManager,
        permissionModeClient: any PermissionModeClientProtocol = PermissionModeClient()
    ) {
        _model = StateObject(
            wrappedValue: PermissionModeStatusModel(
                connectionManager: connectionManager,
                permissionModeClient: permissionModeClient
            )
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text("Permission Controls")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentEmphasized)

            if let lastError = model.lastError {
                Text(lastError)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }

            toggleRow(
                label: "Ask before acting",
                subtitle: model.askBeforeActing
                    ? "Checks in before high-stakes actions"
                    : "Acts autonomously",
                isOn: model.askBeforeActing,
                icon: model.askBeforeActing ? .shieldCheck : .shieldOff
            ) {
                model.toggleAskBeforeActing()
            }

            toggleRow(
                label: "Computer access",
                subtitle: model.hostAccess
                    ? "Can run commands on your computer"
                    : "Cannot access your computer",
                isOn: model.hostAccess,
                icon: model.hostAccess ? .terminal : .lock
            ) {
                model.toggleHostAccess()
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
            .disabled(model.isUpdating)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .accessibilityValue(isOn ? "On" : "Off")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onToggle() }
    }
}
