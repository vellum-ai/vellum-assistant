import SwiftUI
import VellumAssistantShared

/// Reusable header row for recap cards. Displays a circular icon
/// container, title, optional subtitle (thread name), and an optional
/// dismiss button. The dismiss button is rendered automatically when
/// `onDismiss` is non-nil — callers no longer need a separate
/// `showDismiss` flag.
struct HomeRecapCardHeader: View {
    let icon: VIcon
    let iconColor: Color
    let title: String
    let subtitle: String?
    var titleLineLimit: Int? = 1
    let onDismiss: (() -> Void)?

    init(
        icon: VIcon,
        iconColor: Color = VColor.contentDisabled,
        title: String,
        subtitle: String? = nil,
        titleLineLimit: Int? = 1,
        onDismiss: (() -> Void)? = nil
    ) {
        self.icon = icon
        self.iconColor = iconColor
        self.title = title
        self.subtitle = subtitle
        self.titleLineLimit = titleLineLimit
        self.onDismiss = onDismiss
    }

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            iconCircle
            titleStack
            Spacer(minLength: 0)
            dismissButton
        }
    }

    // MARK: - Icon circle

    /// 38pt circular container with white background housing the icon.
    private var iconCircle: some View {
        ZStack {
            Circle()
                .fill(VColor.surfaceLift)
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

    @ViewBuilder
    private var dismissButton: some View {
        if let onDismiss {
            VButton(
                label: "Dismiss",
                iconOnly: "lucide-x",
                style: .outlined,
                size: .pillRegular,
                accessibilityID: "recap-card-dismiss",
                iconColor: VColor.primaryBase
            ) {
                onDismiss()
            }
        }
    }
}
