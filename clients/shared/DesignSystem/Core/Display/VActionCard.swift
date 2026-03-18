import SwiftUI

/// Tappable card for presenting an action choice with icon, title, optional
/// subtitle, and a trailing chevron. Provides hover highlight, press feedback,
/// and pointer cursor.
///
/// Use this for action menus where each option is visually distinct (individual
/// cards with spacing) rather than divider-separated list rows.
public struct VActionCard: View {
    public let icon: String
    public let label: String
    public let subtitle: String?
    public let destructive: Bool
    public let showChevron: Bool
    public let action: () -> Void

    @State private var isHovered = false

    public init(
        icon: String,
        label: String,
        subtitle: String? = nil,
        destructive: Bool = false,
        showChevron: Bool = true,
        action: @escaping () -> Void
    ) {
        self.icon = icon
        self.label = label
        self.subtitle = subtitle
        self.destructive = destructive
        self.showChevron = showChevron
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: VSpacing.md) {
                VIconView(.resolve(icon), size: 14)
                    .foregroundColor(destructive ? VColor.systemNegativeStrong : VColor.contentSecondary)
                    .frame(width: 24, alignment: .center)

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text(label)
                        .font(VFont.bodyMedium)
                        .foregroundColor(destructive ? VColor.systemNegativeStrong : VColor.contentDefault)
                    if let subtitle {
                        Text(subtitle)
                            .font(VFont.caption)
                            .foregroundColor(destructive ? VColor.systemNegativeWeak : VColor.contentTertiary)
                    }
                }

                Spacer(minLength: 0)

                if showChevron {
                    VIconView(.chevronRight, size: 11)
                        .foregroundColor(VColor.contentTertiary)
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isHovered ? VColor.surfaceActive : VColor.surfaceBase)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.borderBase, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
        .buttonStyle(.plain)
        .pointerCursor(onHover: { isHovered = $0 })
        .accessibilityLabel(label)
    }
}
