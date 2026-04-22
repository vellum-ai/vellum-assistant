import SwiftUI

/// Compact status indicator: count, dot, or text label with semantic tone.
/// For categorization with colored backgrounds and icons, use `VTag` instead.
/// Accent tone pairs adaptive `primaryBase` backgrounds with adaptive `contentInset` foregrounds so text stays legible in both light and dark mode.
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

    public enum Shape {
        case pill
        case rounded
    }

    public let style: Style
    public var color: Color = VColor.primaryBase
    public var tone: Tone?
    public var emphasis: Emphasis = .solid
    public var shape: Shape = .pill

    public init(style: Style, color: Color = VColor.primaryBase, shape: Shape = .pill) {
        self.style = style
        self.color = color
        self.shape = shape
    }

    public init(label: String, tone: Tone = .accent, emphasis: Emphasis = .subtle, shape: Shape = .pill) {
        self.style = .label(label)
        self.color = VColor.primaryBase
        self.tone = tone
        self.emphasis = emphasis
        self.shape = shape
    }

    public var body: some View {
        switch style {
        case .count(let count):
            Text("\(count)")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.auxWhite)
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
            Text(text)
                .font(VFont.labelDefault)
                .foregroundStyle(labelForegroundColor)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, labelVerticalPadding)
                .background(labelBackgroundColor)
                .modifier(LabelShapeModifier(shape: shape, borderColor: labelBorderColor, borderWidth: labelBorderWidth))
                .accessibilityLabel(text)
        }
    }

    // MARK: - Shape Helpers

    private var labelVerticalPadding: CGFloat {
        shape == .rounded ? VSpacing.xs : VSpacing.xxs
    }

    // MARK: - Color Resolution

    private var labelForegroundColor: Color {
        guard let tone else {
            return emphasis == .subtle ? VColor.contentEmphasized : VColor.auxWhite
        }

        switch (tone, emphasis) {
        case (.accent, .solid):
            return VColor.contentInset
        case (.positive, .solid), (.danger, .solid):
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
        guard let tone else {
            return emphasis == .subtle ? color.opacity(0.2) : color
        }

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

// MARK: - Shape Modifier

/// Applies the correct clip shape and border overlay based on VBadge.Shape.
private struct LabelShapeModifier: ViewModifier {
    let shape: VBadge.Shape
    let borderColor: Color
    let borderWidth: CGFloat

    func body(content: Content) -> some View {
        switch shape {
        case .pill:
            content
                .overlay(Capsule().stroke(borderColor, lineWidth: borderWidth))
                .clipShape(Capsule())
        case .rounded:
            content
                .overlay(RoundedRectangle(cornerRadius: VRadius.sm).stroke(borderColor, lineWidth: borderWidth))
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        }
    }
}
