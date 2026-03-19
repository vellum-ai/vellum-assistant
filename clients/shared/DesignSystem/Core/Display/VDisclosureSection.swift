import SwiftUI

/// A disclosure section with a full-row clickable header.
///
/// Replaces native `DisclosureGroup` to provide a larger tap target — the entire
/// header row (title + optional subtitle + chevron) toggles expansion, not just
/// the tiny default chevron.
///
/// Usage:
/// ```swift
/// VDisclosureSection(title: "Advanced", icon: "gearshape", subtitle: "Bearer token, developer options", isExpanded: $expanded) {
///     Text("Content here")
/// }
/// ```
public struct VDisclosureSection<Content: View>: View {

    public enum Size {
        /// Default density — generous spacing for standalone sections.
        case `default`
        /// Compact density — tighter spacing matching sidebar row metrics.
        case compact
    }

    public var size: Size = .default
    public let title: String
    public var icon: String? = nil
    public var subtitle: String? = nil
    @Binding public var isExpanded: Bool
    @ViewBuilder public let content: () -> Content

    @State private var isHovered = false

    public init(
        size: Size = .default,
        title: String,
        icon: String? = nil,
        subtitle: String? = nil,
        isExpanded: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.size = size
        self.title = title
        self.icon = icon
        self.subtitle = subtitle
        self._isExpanded = isExpanded
        self.content = content
    }

    private var iconSize: CGFloat {
        switch size {
        case .default: return 14
        case .compact: return 13
        }
    }

    private var headerSpacing: CGFloat {
        switch size {
        case .default: return VSpacing.sm
        case .compact: return VSpacing.xs
        }
    }

    private var titleFont: Font {
        switch size {
        case .default: return VFont.bodyBold
        case .compact: return VFont.body
        }
    }

    private var titleColor: Color {
        switch size {
        case .default: return VColor.contentDefault
        case .compact: return VColor.contentSecondary
        }
    }

    private var contentTopPadding: CGFloat {
        switch size {
        case .default: return VSpacing.sm
        case .compact: return VSpacing.xxs
        }
    }

    private var headerLeadingPadding: CGFloat {
        switch size {
        case .default: return 0
        case .compact: return VSpacing.xs
        }
    }

    private var headerTrailingPadding: CGFloat {
        switch size {
        case .default: return 0
        case .compact: return VSpacing.sm
        }
    }

    private var headerVerticalPadding: CGFloat {
        switch size {
        case .default: return 0
        case .compact: return VSpacing.xs
        }
    }

    private var headerMinHeight: CGFloat? {
        switch size {
        case .default: return nil
        case .compact: return 32
        }
    }

    private var iconColor: Color {
        switch size {
        case .default: return VColor.contentTertiary
        case .compact: return VColor.primaryBase
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(VAnimation.fast) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: headerSpacing) {
                    if let icon {
                        VIconView(.resolve(icon), size: iconSize)
                            .foregroundColor(iconColor)
                            .frame(width: 20)
                    }

                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text(title)
                            .font(titleFont)
                            .foregroundColor(titleColor)
                        if let subtitle {
                            Text(subtitle)
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }

                    Spacer()

                    VIconView(.chevronRight, size: 10)
                        .foregroundColor(VColor.contentTertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .animation(VAnimation.fast, value: isExpanded)
                }
                .padding(.leading, headerLeadingPadding)
                .padding(.trailing, headerTrailingPadding)
                .padding(.vertical, headerVerticalPadding)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(minHeight: headerMinHeight)
                .background(
                    size == .compact && isHovered ? VColor.surfaceBase : Color.clear
                )
                .animation(VAnimation.fast, value: isHovered)
                .clipShape(RoundedRectangle(cornerRadius: size == .compact ? VRadius.md : 0))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { isHovered = $0 }
            .pointerCursor()
            .accessibilityLabel(subtitle.map { "\(title), \($0)" } ?? title)
            .accessibilityValue(isExpanded ? "expanded" : "collapsed")
            .accessibilityHint("Double-tap to \(isExpanded ? "collapse" : "expand")")

            if isExpanded {
                content()
                    .padding(.top, contentTopPadding)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}

