import SwiftUI

struct VBadge: View {
    enum Style {
        case count(Int)
        case dot
        case label(String)
    }

    let style: Style
    var color: Color = VColor.accent

    var body: some View {
        switch style {
        case .count(let count):
            Text("\(count)")
                .font(VFont.small)
                .foregroundColor(.white)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xxs)
                .background(color)
                .clipShape(Capsule())
                .accessibilityLabel("\(count) items")

        case .dot:
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)

        case .label(let text):
            Text(text)
                .font(VFont.small)
                .foregroundColor(.white)
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.xxs)
                .background(color)
                .clipShape(Capsule())
                .accessibilityLabel(text)
        }
    }
}
