import SwiftUI

public struct VEmptyState: View {
    public let title: String
    public var subtitle: String? = nil
    public var icon: String? = nil
    public var actionLabel: String? = nil
    public var actionIcon: String? = nil
    public var action: (() -> Void)? = nil

    public init(
        title: String,
        subtitle: String? = nil,
        icon: String? = nil,
        actionLabel: String? = nil,
        actionIcon: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.title = title
        self.subtitle = subtitle
        self.icon = icon
        self.actionLabel = actionLabel
        self.actionIcon = actionIcon
        self.action = action
    }

    public var body: some View {
        VStack(spacing: VSpacing.lg) {
            if let icon = icon {
                VIconView(.resolve(icon), size: 48)
                    .foregroundColor(VColor.contentTertiary)
            }
            Text(title)
                .font(VFont.bodyMediumDefault)
                .foregroundColor(VColor.contentTertiary)
            if let subtitle = subtitle {
                Text(subtitle)
                    .font(VFont.bodyMediumLighter)
                    .foregroundColor(VColor.contentTertiary)
            }
            if let actionLabel, let action {
                VButton(
                    label: actionLabel,
                    leftIcon: actionIcon,
                    style: .primary,
                    action: action
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: actionLabel != nil && action != nil ? .contain : .ignore)
        .accessibilityLabel("\(title). \(subtitle ?? "")")
    }
}

