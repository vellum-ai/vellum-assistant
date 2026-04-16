import SwiftUI
import VellumAssistantShared

/// Recap card for agent-to-agent messages. Displays an assistant
/// avatar, the message title, an optional thread name, and
/// Authorise / Deny action buttons.
struct HomeAssistantCard: View {
    let title: String
    let threadName: String?
    let showDismiss: Bool
    let onAuthorise: () -> Void
    let onDeny: () -> Void
    let onDismiss: (() -> Void)?

    init(
        title: String,
        threadName: String? = nil,
        showDismiss: Bool = false,
        onAuthorise: @escaping () -> Void,
        onDeny: @escaping () -> Void,
        onDismiss: (() -> Void)? = nil
    ) {
        self.title = title
        self.threadName = threadName
        self.showDismiss = showDismiss
        self.onAuthorise = onAuthorise
        self.onDeny = onDeny
        self.onDismiss = onDismiss
    }

    var body: some View {
        VStack(spacing: VSpacing.md) {
            HomeRecapCardHeader(
                icon: .circleUser,
                iconColor: VColor.contentSecondary,
                title: title,
                subtitle: threadName,
                showDismiss: showDismiss,
                onDismiss: onDismiss
            )

            actionButtons
        }
        .recapCardGlass()
    }

    // MARK: - Action buttons

    /// Authorise and Deny bordered pill buttons.
    private var actionButtons: some View {
        HStack(spacing: VSpacing.sm) {
            actionButton(label: "Authorise", action: onAuthorise)
            actionButton(label: "Deny", action: onDeny)
        }
    }

    /// Bordered pill button with capsule outline, 32pt height.
    private func actionButton(label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.primaryBase)
                .frame(height: 32)
                .padding(.horizontal, VSpacing.md)
                .background(
                    Capsule()
                        .strokeBorder(VColor.borderElement, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }
}
