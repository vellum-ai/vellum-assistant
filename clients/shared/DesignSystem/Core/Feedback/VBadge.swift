import SwiftUI

public struct VBadge: View {
    public enum Style {
        case count(Int)
        case dot
        case label(String)
    }

    public enum Tone {
        case accent
        case neutral
        case positive
        case warning
        case danger
    }

    public enum Emphasis {
        case solid
        case subtle
    }

    public let style: Style
    public var color: Color = VColor.primaryBase
    public var tone: Tone?
    public var emphasis: Emphasis = .solid
    public var icon: VIcon?
    public var iconColor: Color?

    public init(style: Style, color: Color = VColor.primaryBase) {
        self.style = style
        self.color = color
    }

    public init(label: String, icon: VIcon? = nil, iconColor: Color? = nil, tone: Tone = .accent, emphasis: Emphasis = .subtle) {
        self.style = .label(label)
        self.color = VColor.primaryBase
        self.tone = tone
        self.emphasis = emphasis
        self.icon = icon
        self.iconColor = iconColor
    }

    public var body: some View {
        switch style {
        case .count(let count):
            Text("\(count)")
                .font(VFont.caption)
                .foregroundColor(VColor.auxWhite)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xxs)
                .background(color)
                .clipShape(Capsule())
                .accessibilityLabel("\(count) \(count == 1 ? "item" : "items")")

        case .dot:
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)

        case .label(let text):
            HStack(spacing: VSpacing.xxs) {
                if let icon {
                    VIconView(icon, size: 12)
                        .foregroundColor(iconColor ?? labelForegroundColor)
                }
                Text(text)
                    .font(VFont.caption)
                    .foregroundColor(labelForegroundColor)
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xxs)
            .background(labelBackgroundColor)
            .overlay(
                Capsule()
                    .stroke(labelBorderColor, lineWidth: labelBorderWidth)
            )
            .clipShape(Capsule())
            .accessibilityLabel(text)
        }
    }

    private var labelForegroundColor: Color {
        guard let tone else { return VColor.auxWhite }

        switch (tone, emphasis) {
        case (.accent, .solid), (.positive, .solid), (.danger, .solid):
            return VColor.auxWhite
        case (.warning, .solid):
            return VColor.contentEmphasized
        case (.neutral, .solid):
            return VColor.contentSecondary
        case (.accent, .subtle):
            return VColor.primaryBase
        case (.neutral, .subtle):
            return VColor.contentSecondary
        case (.positive, .subtle):
            return VColor.systemPositiveStrong
        case (.warning, .subtle):
            return VColor.systemMidStrong
        case (.danger, .subtle):
            return VColor.systemNegativeStrong
        }
    }

    private var labelBackgroundColor: Color {
        guard let tone else { return color }

        switch (tone, emphasis) {
        case (.accent, .solid):
            return VColor.primaryBase
        case (.neutral, .solid):
            return VColor.surfaceBase
        case (.positive, .solid):
            return VColor.systemPositiveStrong
        case (.warning, .solid):
            return VColor.systemMidStrong
        case (.danger, .solid):
            return VColor.systemNegativeStrong
        case (.accent, .subtle):
            return VColor.primaryBase.opacity(0.10)
        case (.neutral, .subtle):
            return VColor.surfaceBase
        case (.positive, .subtle):
            return VColor.systemPositiveWeak
        case (.warning, .subtle):
            return VColor.systemMidWeak
        case (.danger, .subtle):
            return VColor.systemNegativeWeak
        }
    }

    private var labelBorderColor: Color {
        guard let tone else { return Color.clear }

        switch (tone, emphasis) {
        case (_, .solid):
            return Color.clear
        case (.accent, .subtle):
            return VColor.primaryBase.opacity(0.18)
        case (.neutral, .subtle):
            return VColor.borderBase.opacity(0.55)
        case (.positive, .subtle):
            return VColor.systemPositiveStrong.opacity(0.14)
        case (.warning, .subtle):
            return VColor.systemMidStrong.opacity(0.16)
        case (.danger, .subtle):
            return VColor.systemNegativeStrong.opacity(0.16)
        }
    }

    private var labelBorderWidth: CGFloat {
        tone == nil ? 0 : 1
    }
}
