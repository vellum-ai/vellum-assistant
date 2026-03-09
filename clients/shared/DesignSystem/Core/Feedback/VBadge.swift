import SwiftUI

public struct VBadge: View {
    public enum Style {
        case count(Int)
        case dot
        case label(String)
    }

    public let style: Style
    public var color: Color = VColor.accent

    public init(style: Style, color: Color = VColor.accent) {
        self.style = style
        self.color = color
    }

    public var body: some View {
        switch style {
        case .count(let count):
            Text("\(count)")
                .font(VFont.caption)
                .foregroundColor(.white)
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
                .foregroundColor(.white)
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
        VColor.background.ignoresSafeArea()
        VStack(spacing: 16) {
            HStack(spacing: 12) {
                VBadge(style: .count(5))
                VBadge(style: .count(42), color: VColor.error)
                VBadge(style: .count(99), color: VColor.success)
            }
            HStack(spacing: 12) {
                VBadge(style: .dot)
                VBadge(style: .dot, color: VColor.success)
                VBadge(style: .dot, color: VColor.error)
                VBadge(style: .dot, color: VColor.warning)
            }
            HStack(spacing: 12) {
                VBadge(style: .label("New"))
                VBadge(style: .label("Beta"), color: VColor.success)
                VBadge(style: .label("Error"), color: VColor.error)
            }
        }
        .padding()
    }
    .frame(width: 350, height: 200)
}
