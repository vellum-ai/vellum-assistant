import SwiftUI

public struct VBadge: View {
    public enum Style {
        case count(Int)
        case dot
        case label(String)
        /// Subtle variant: colored text on a semi-transparent background.
        case subtleLabel(String)
    }

    public let style: Style
    public var color: Color = VColor.primaryBase

    public init(style: Style, color: Color = VColor.primaryBase) {
        self.style = style
        self.color = color
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
            Text(text)
                .font(VFont.caption)
                .foregroundColor(VColor.auxWhite)
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.xxs)
                .background(color)
                .clipShape(Capsule())
                .accessibilityLabel(text)

        case .subtleLabel(let text):
            Text(text)
                .font(VFont.caption)
                .foregroundColor(color)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xxs)
                .background(color.opacity(0.12))
                .clipShape(Capsule())
                .accessibilityLabel(text)
        }
    }
}

