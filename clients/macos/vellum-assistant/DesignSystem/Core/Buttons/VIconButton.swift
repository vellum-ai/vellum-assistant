import SwiftUI

struct VIconButton: View {
    let label: String
    var icon: String = ""
    var customIcon: Image? = nil
    var isActive: Bool = false
    var iconOnly: Bool = false
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: VSpacing.xs) {
                if let customIcon {
                    customIcon
                        .font(.system(size: 12, weight: .medium))
                } else {
                    Image(systemName: icon)
                        .font(.system(size: 12, weight: .medium))
                }
                if !iconOnly {
                    Text(label)
                        .font(VFont.caption)
                }
            }
        }
        .buttonStyle(VIconButtonStyle(isActive: isActive, isHovered: isHovered, iconOnly: iconOnly))
        .onHover { hovering in
            isHovered = hovering
            if hovering {
                NSCursor.pointingHand.set()
            } else {
                NSCursor.arrow.set()
            }
        }
        .accessibilityLabel(label)
    }
}

private struct VIconButtonStyle: ButtonStyle {
    let isActive: Bool
    let isHovered: Bool
    let iconOnly: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(isActive ? VColor.textPrimary : VColor.textSecondary)
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.buttonV)
            .background(backgroundColor(isPressed: configuration.isPressed))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
            .contentShape(RoundedRectangle(cornerRadius: VRadius.pill))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.pill)
                    .stroke(isActive ? VColor.textSecondary : VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
            )
            .animation(VAnimation.fast, value: configuration.isPressed)
            .animation(VAnimation.fast, value: isHovered)
    }

    private func backgroundColor(isPressed: Bool) -> Color {
        if isActive {
            if isPressed { return Slate._500 }
            if isHovered { return Slate._600 }
            return VColor.surfaceBorder
        } else {
            if isPressed { return Slate._600 }
            if isHovered { return Slate._700 }
            return .clear
        }
    }
}

#Preview("VIconButton") {
    ZStack {
        VColor.background.ignoresSafeArea()
        HStack(spacing: 12) {
            VIconButton(label: "Settings", icon: "gear") {}
            VIconButton(label: "Active", icon: "star.fill", isActive: true) {}
            VIconButton(label: "Icon Only", icon: "plus", iconOnly: true) {}
            VIconButton(label: "Active Icon", icon: "pencil", isActive: true, iconOnly: true) {}
        }
        .padding()
    }
    .frame(width: 400, height: 80)
}
