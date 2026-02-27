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
            .foregroundColor(iconForegroundColor)
        }
        .buttonStyle(VIconButtonStyle(isActive: isActive, isHovered: isHovered))
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

    private var iconForegroundColor: Color {
        if isActive {
            return adaptiveColor(light: Color(hex: 0x4B6845), dark: Forest._300)
        }
        return adaptiveColor(light: Color(hex: 0x4B6845), dark: Forest._400)
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

public struct VIconButtonStyle: ButtonStyle {
    public var isActive: Bool
    public var isHovered: Bool
    public var isFocused: Bool
    public var size: CGFloat?

    @Environment(\.isEnabled) private var isEnabled

    public init(isActive: Bool = false, isHovered: Bool, isFocused: Bool = false, size: CGFloat? = nil) {
        self.isActive = isActive
        self.isHovered = isHovered
        self.isFocused = isFocused
        self.size = size
    }

    public func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: VRadius.md)

        configuration.label
            .frame(width: size, height: size)
            .padding(size == nil ? VSpacing.sm : 0)
            .background(shape.fill(backgroundColor(isPressed: configuration.isPressed)))
            .overlay(
                shape.stroke(
                    borderColor,
                    lineWidth: isEnabled && isFocused ? 1.25 : 1
                )
            )
            .clipShape(shape)
            .contentShape(shape)
            .focusEffectDisabled()
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(VAnimation.fast, value: configuration.isPressed)
            .animation(VAnimation.fast, value: isHovered)
            .animation(VAnimation.fast, value: isFocused)
    }

    private func backgroundColor(isPressed: Bool) -> Color {
        guard isEnabled else {
            return isActive ? adaptiveColor(light: Moss._100, dark: Moss._700).opacity(0.5) : .clear
        }
        if isActive {
            if isPressed { return adaptiveColor(light: Moss._200, dark: Moss._600) }
            if isHovered { return adaptiveColor(light: Moss._200, dark: Moss._600) }
            return adaptiveColor(light: Moss._100, dark: Moss._700)
        } else {
            if isPressed { return adaptiveColor(light: Moss._200, dark: Moss._600) }
            if isHovered { return adaptiveColor(light: Moss._100, dark: Moss._700) }
            return .clear
        }
    }

    private var borderColor: Color {
        guard isEnabled, isFocused else { return .clear }
        return VColor.accent.opacity(0.72)
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
