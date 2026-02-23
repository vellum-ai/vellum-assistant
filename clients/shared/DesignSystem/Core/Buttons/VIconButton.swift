import SwiftUI
#if os(macOS)
import AppKit
#endif

public struct VIconButton: View {
    public let label: String
    public var icon: String = ""
    public var customIcon: Image? = nil
    public var isActive: Bool = false
    public var iconOnly: Bool = false
    public var tooltip: String? = nil
    public let action: () -> Void

    @State private var isHovered = false

    public init(label: String, icon: String = "", customIcon: Image? = nil, isActive: Bool = false, iconOnly: Bool = false, tooltip: String? = nil, action: @escaping () -> Void) {
        self.label = label
        self.icon = icon
        self.customIcon = customIcon
        self.isActive = isActive
        self.iconOnly = iconOnly
        self.tooltip = tooltip
        self.action = action
    }

    public var body: some View {
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
        .modifier(OptionalHelpModifier(tooltip: tooltip))
    }
}

/// Applies `.help()` only when a tooltip string is provided, avoiding an
/// empty help wrapper that can affect hit-testing and hover behavior.
private struct OptionalHelpModifier: ViewModifier {
    let tooltip: String?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let tooltip {
            content.help(tooltip)
        } else {
            content
        }
    }
}

private struct VIconButtonStyle: ButtonStyle {
    let isActive: Bool
    let isHovered: Bool
    let iconOnly: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(VColor.iconAccent)
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.buttonV)
            .background(backgroundColor(isPressed: configuration.isPressed))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .contentShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(isActive ? VColor.iconAccent : VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
            )
            .animation(VAnimation.fast, value: configuration.isPressed)
            .animation(VAnimation.fast, value: isHovered)
    }

    private func backgroundColor(isPressed: Bool) -> Color {
        if isActive {
            if isPressed { return VColor.ghostPressed }
            if isHovered { return VColor.ghostHover }
            return VColor.buttonTertiaryBackground
        } else {
            if isPressed { return VColor.ghostPressed }
            if isHovered { return VColor.ghostHover }
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
