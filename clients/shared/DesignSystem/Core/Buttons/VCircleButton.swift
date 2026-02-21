import SwiftUI
#if os(macOS)
import AppKit
#endif

public struct VCircleButton: View {
    public let icon: String              // SF Symbol name
    public let label: String             // Human-readable accessibility label
    public var fillColor: Color = Emerald._600
    public var iconColor: Color = .white
    public var size: CGFloat = 36
    public var iconSize: CGFloat = 14
    public let action: () -> Void

    @State private var isHovered = false

    public init(icon: String, label: String, fillColor: Color = Emerald._600, iconColor: Color = .white, size: CGFloat = 36, iconSize: CGFloat = 14, action: @escaping () -> Void) {
        self.icon = icon
        self.label = label
        self.fillColor = fillColor
        self.iconColor = iconColor
        self.size = size
        self.iconSize = iconSize
        self.action = action
    }

    public var body: some View {
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
        .buttonStyle(VCircleButtonStyle(isHovered: isHovered))
        #if os(macOS)
        .onHover { hovering in
            isHovered = hovering
            if hovering { NSCursor.pointingHand.set() }
            else { NSCursor.arrow.set() }
        }
        #else
        .onHover { isHovered = $0 }
        #endif
        .accessibilityLabel(label)
    }
}

private struct VCircleButtonStyle: ButtonStyle {
    let isHovered: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .brightness(configuration.isPressed ? 0.2 : isHovered ? 0.1 : 0)
            .animation(VAnimation.fast, value: configuration.isPressed)
            .animation(VAnimation.fast, value: isHovered)
    }
}

#Preview("VCircleButton") {
    ZStack {
        VColor.background.ignoresSafeArea()
        HStack(spacing: 12) {
            VCircleButton(icon: "phone.fill", label: "Phone") {}
            VCircleButton(icon: "phone.fill", label: "Phone", fillColor: Emerald._600.opacity(0.5)) {}
            VCircleButton(icon: "plus", label: "Add", fillColor: Forest._500, size: 28, iconSize: 12) {}
        }
        .padding()
    }
    .frame(width: 200, height: 80)
}
