import SwiftUI

struct VCircleButton: View {
    let icon: String              // SF Symbol name
    let label: String             // Human-readable accessibility label
    var fillColor: Color = Emerald._600
    var iconColor: Color = .white
    var size: CGFloat = 36
    var iconSize: CGFloat = 14
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Circle()
                .fill(fillColor)
                .frame(width: size, height: size)
                .overlay(
                    Image(systemName: icon)
                        .foregroundColor(iconColor)
                        .font(.system(size: iconSize))
                )
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            NSCursor.pointingHand.set()
            if !hovering { NSCursor.arrow.set() }
        }
        .accessibilityLabel(label)
    }
}

#Preview("VCircleButton") {
    ZStack {
        VColor.background.ignoresSafeArea()
        HStack(spacing: 12) {
            VCircleButton(icon: "phone.fill", label: "Phone") {}
            VCircleButton(icon: "phone.fill", label: "Phone", fillColor: Emerald._600.opacity(0.5)) {}
            VCircleButton(icon: "plus", label: "Add", fillColor: Violet._500, size: 28, iconSize: 12) {}
        }
        .padding()
    }
    .frame(width: 200, height: 80)
}
