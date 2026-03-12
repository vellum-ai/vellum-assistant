import SwiftUI

public struct VBadge: View {
    public enum Style {
        case count(Int)
        case dot
        case label(String)
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
        }
    }
}

#Preview("VBadge") {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        VStack(spacing: 16) {
            HStack(spacing: 12) {
                VBadge(style: .count(5))
                VBadge(style: .count(42), color: VColor.systemNegativeStrong)
                VBadge(style: .count(99), color: VColor.systemPositiveStrong)
            }
            HStack(spacing: 12) {
                VBadge(style: .dot)
                VBadge(style: .dot, color: VColor.systemPositiveStrong)
                VBadge(style: .dot, color: VColor.systemNegativeStrong)
                VBadge(style: .dot, color: VColor.systemNegativeHover)
            }
            HStack(spacing: 12) {
                VBadge(style: .label("New"))
                VBadge(style: .label("Beta"), color: VColor.systemPositiveStrong)
                VBadge(style: .label("Error"), color: VColor.systemNegativeStrong)
            }
        }
        .padding()
    }
    .frame(width: 350, height: 200)
}
