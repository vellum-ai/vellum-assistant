import SwiftUI

/// Compact single-line notification bar with optional action and dismiss. Positioned inline or pinned above content. See FeedbackGallerySection for variants.
public struct VNotification: View {
    public enum Tone { case positive, negative, warning, neutral }
    public enum Style { case weak, strong }

    public let message: String
    public var tone: Tone
    public var style: Style
    public var showsLeadingIcon: Bool
    public var actionLabel: String?
    public var onAction: (() -> Void)?
    public var onDismiss: (() -> Void)?

    public init(
        _ message: String,
        tone: Tone = .positive,
        style: Style = .weak,
        showsLeadingIcon: Bool = true,
        actionLabel: String? = nil,
        onAction: (() -> Void)? = nil,
        onDismiss: (() -> Void)? = nil
    ) {
        self.message = message
        self.tone = tone
        self.style = style
        self.showsLeadingIcon = showsLeadingIcon
        self.actionLabel = actionLabel
        self.onAction = onAction
        self.onDismiss = onDismiss
    }

    public var body: some View {
        HStack(alignment: .center, spacing: 0) {
            if showsLeadingIcon {
                HStack(spacing: VSpacing.xs) {
                    VIconView(leadingIcon, size: 12)
                        .foregroundStyle(foregroundColor)
                        .accessibilityHidden(true)
                    Text(message)
                        .font(textFont)
                        .foregroundStyle(textColor)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            } else {
                Text(message)
                    .font(textFont)
                    .foregroundStyle(textColor)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer()

            if hasTrailingCluster {
                let actionRendered = actionLabel != nil && onAction != nil
                HStack(spacing: VSpacing.sm) {
                    if let actionLabel, let onAction {
                        divider
                        Button(action: onAction) {
                            Text(actionLabel)
                                .font(VFont.labelDefault)
                                .foregroundStyle(foregroundColor)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(actionLabel)
                    }
                    if let onDismiss {
                        if actionRendered {
                            divider
                        }
                        Button(action: onDismiss) {
                            VIconView(.x, size: 10)
                                .foregroundStyle(foregroundColor)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Dismiss \(toneA11yLabel.lowercased()): \(message)")
                    }
                }
            }
        }
        .frame(height: 32)
        .padding(.horizontal, VSpacing.sm)
        .background(backgroundColor)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .accessibilityElement(children: isInteractive ? .contain : .combine)
        .accessibilityLabel("\(toneA11yLabel). \(message)")
    }

    private var toneA11yLabel: String {
        switch tone {
        case .positive: return "Success"
        case .negative: return "Error"
        case .warning: return "Warning"
        case .neutral: return "Notice"
        }
    }

    private var hasTrailingCluster: Bool {
        (actionLabel != nil && onAction != nil) || onDismiss != nil
    }

    private var isInteractive: Bool {
        (actionLabel != nil && onAction != nil) || onDismiss != nil
    }

    private var divider: some View {
        Rectangle()
            .fill(foregroundColor.opacity(dividerOpacity))
            .frame(width: 1, height: 18)
            .accessibilityHidden(true)
    }

    private var textFont: Font {
        switch style {
        case .weak: return VFont.bodyMediumDefault
        case .strong: return VFont.bodyMediumLighter
        }
    }

    private var textColor: Color {
        if case .neutral = tone, case .weak = style {
            return VColor.contentTertiary
        }
        return foregroundColor
    }

    private var backgroundColor: Color {
        switch (tone, style) {
        case (.positive, .weak): return VColor.systemPositiveWeak
        case (.positive, .strong): return VColor.systemPositiveStrong
        case (.negative, .weak): return VColor.systemNegativeWeak
        case (.negative, .strong): return VColor.systemNegativeStrong
        case (.warning, .weak): return VColor.systemMidWeak
        case (.warning, .strong): return VColor.systemMidStrong
        case (.neutral, .weak): return VColor.contentBackground
        case (.neutral, .strong): return VColor.contentSecondary
        }
    }

    private var foregroundColor: Color {
        switch (tone, style) {
        case (.warning, .strong): return VColor.auxBlack
        case (_, .strong): return VColor.contentInset
        case (.positive, .weak): return VColor.systemPositiveStrong
        case (.negative, .weak): return VColor.systemNegativeStrong
        case (.warning, .weak): return VColor.systemMidStrong
        case (.neutral, .weak): return VColor.contentTertiary
        }
    }

    private var dividerOpacity: Double {
        switch (tone, style) {
        case (.neutral, .weak): return 0.20
        default: return 0.30
        }
    }

    private var leadingIcon: VIcon {
        switch tone {
        case .positive: return .circleCheck
        case .negative: return .circleX
        case .warning: return .triangleAlert
        case .neutral: return .info
        }
    }
}
