import SwiftUI
import VellumAssistantShared

/// Reusable header row for recap cards. Displays a circular icon
/// container, title, optional subtitle (thread name), and an
/// optional dismiss button.
struct HomeRecapCardHeader: View {
    let icon: VIcon
    let iconColor: Color
    let title: String
    let subtitle: String?
    var titleLineLimit: Int? = 1
    let showDismiss: Bool
    let onDismiss: (() -> Void)?

    init(
        icon: VIcon,
        iconColor: Color = VColor.contentDisabled,
        title: String,
        subtitle: String? = nil,
        titleLineLimit: Int? = 1,
        showDismiss: Bool = false,
        onDismiss: (() -> Void)? = nil
    ) {
        self.icon = icon
        self.iconColor = iconColor
        self.title = title
        self.subtitle = subtitle
        self.titleLineLimit = titleLineLimit
        self.showDismiss = showDismiss
        self.onDismiss = onDismiss
    }

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            iconCircle
            titleStack
            Spacer(minLength: 0)
            if showDismiss {
                dismissButton
            }
        }
    }

    // MARK: - Icon circle

    /// 38pt circular container with white background housing the icon.
    private var iconCircle: some View {
        ZStack {
            Circle()
                .fill(VColor.surfaceActive)
                .frame(width: 38, height: 38)

            VIconView(icon, size: 18)
                .foregroundStyle(iconColor)
        }
    }

    // MARK: - Title stack

    private var titleStack: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(title)
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentEmphasized)
                .lineLimit(titleLineLimit)

            if let subtitle {
                Text(subtitle)
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineLimit(1)
            }
        }
    }

    // MARK: - Dismiss button

    /// Bordered pill dismiss button with an X icon. 32pt height matches
    /// the action buttons used across all home recap cards.
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
