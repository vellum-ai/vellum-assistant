import SwiftUI
import VellumAssistantShared

/// Recap card for agent-to-agent messages. Header shows the assistant
/// avatar + message title + optional thread name + X dismiss. Allow Once
/// and Deny pill action buttons. Structurally identical to
/// HomePermissionCard (without the inner content area), differing only
/// in the header icon.
struct HomeAssistantCard: View {
    let title: String
    let threadName: String?
    let onAuthorise: () -> Void
    let onDeny: () -> Void
    let onDismiss: (() -> Void)?

    init(
        title: String,
        threadName: String? = nil,
        onAuthorise: @escaping () -> Void,
        onDeny: @escaping () -> Void,
        onDismiss: (() -> Void)? = nil
    ) {
        self.title = title
        self.threadName = threadName
        self.onAuthorise = onAuthorise
        self.onDeny = onDeny
        self.onDismiss = onDismiss
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            headerRow
            actionButtons
        }
        .recapCardGlass()
    }

    // MARK: - Header

    private var headerRow: some View {
        HStack(spacing: VSpacing.sm) {
            iconCircle
            titleStack
            Spacer(minLength: 0)
            dismissButton
        }
    }

    private var iconCircle: some View {
        ZStack {
            Circle()
                .fill(VColor.surfaceLift)
                .frame(width: 38, height: 38)
            VIconView(.circleUser, size: 18)
                .foregroundStyle(VColor.contentDisabled)
        }
    }

    @ViewBuilder
    private var titleStack: some View {
        if let threadName {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(title)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentEmphasized)
                    .multilineTextAlignment(.leading)
                Text(threadName)
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineLimit(1)
            }
        } else {
            Text(title)
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentEmphasized)
                .multilineTextAlignment(.leading)
        }
    }

    // MARK: - Action buttons

    /// Allow Once + Deny pill buttons matching HomePermissionCard styling.
    private var actionButtons: some View {
        HStack(spacing: VSpacing.xs) {
            allowOnceButton
            denyButton
        }
    }

    private var allowOnceButton: some View {
        Button {
            onAuthorise()
        } label: {
            Text("Allow Once")
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentInset)
                .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
                .frame(height: 32)
                .background(Capsule().fill(VColor.primaryBase))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Allow Once")
    }

    private var denyButton: some View {
        Button {
            onDeny()
        } label: {
            Text("Deny")
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentInset)
                .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
                .frame(height: 32)
                .background(Capsule().fill(VColor.systemNegativeStrong))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Deny")
    }

    private var dismissButton: some View {
        Button {
            onDismiss?()
        } label: {
            VIconView(.x, size: 12)
                .foregroundStyle(VColor.primaryBase)
                .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
                .frame(height: 32)
                .background(
                    Capsule()
                        .strokeBorder(VColor.borderElement, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dismiss")
    }
}
