import SwiftUI
#if os(macOS)
import AppKit
#endif

public enum VIconButtonVariant {
    case standard
    case filled(Color)
    case outlined
}

public struct VIconButton: View {
    public let label: String
    public var icon: String = ""
    public var customIcon: Image? = nil
    public var isActive: Bool = false
    public var iconOnly: Bool = false
    public var variant: VIconButtonVariant = .standard
    public var size: CGFloat? = nil
    public var tooltip: String? = nil
    public let action: () -> Void

    @State private var isHovered = false
    @FocusState private var isFocused: Bool

    public init(label: String, icon: String = "", customIcon: Image? = nil, isActive: Bool = false, iconOnly: Bool = false, variant: VIconButtonVariant = .standard, size: CGFloat? = nil, tooltip: String? = nil, action: @escaping () -> Void) {
        self.label = label
        self.icon = icon
        self.customIcon = customIcon
        self.isActive = isActive
        self.iconOnly = iconOnly
        self.variant = variant
        self.size = size
        self.tooltip = tooltip
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: VSpacing.xs) {
                if let customIcon {
                    customIcon
                        .font(.system(size: 11, weight: .medium))
                        .frame(width: 20, height: 20)
                } else {
                    VIconView(.resolve(icon), size: 13)
                        .frame(width: 20, height: 20)
                }
                if !iconOnly {
                    Text(label)
                        .font(VFont.caption)
                }
            }
            .foregroundColor(iconForegroundForVariant)
        }
        .focused($isFocused)
        .buttonStyle(VIconButtonStyle(isActive: isActive, isHovered: isHovered, isFocused: isFocused, size: size, variant: variant))
        #if os(macOS)
        .onHover { hovering in
            isHovered = hovering
            switch variant {
            case .filled: break
            default:
                if hovering { NSCursor.pointingHand.set() }
                else { NSCursor.arrow.set() }
            }
        }
        #else
        .onHover { isHovered = $0 }
        #endif
        .accessibilityLabel(label)
        .modifier(OptionalHelpModifier(tooltip: tooltip))
    }

    private var iconForegroundForVariant: Color {
        if case .filled = variant {
            return .white
        }
        return iconForegroundColor
    }

    private var iconForegroundColor: Color {
        if isActive {
            return adaptiveColor(light: Color(hex: 0x537D53), dark: Forest._300)
        }
        return adaptiveColor(light: Color(hex: 0x537D53), dark: Forest._400)
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
    public var variant: VIconButtonVariant

    @Environment(\.isEnabled) private var isEnabled

    public init(isActive: Bool = false, isHovered: Bool, isFocused: Bool = false, size: CGFloat? = nil, variant: VIconButtonVariant = .standard) {
        self.isActive = isActive
        self.isHovered = isHovered
        self.isFocused = isFocused
        self.size = size
        self.variant = variant
    }

    public func makeBody(configuration: Configuration) -> some View {
        let cornerRadius: CGFloat = {
            if case .filled = variant { return VRadius.md }
            return VRadius.md
        }()
        let shape = RoundedRectangle(cornerRadius: cornerRadius)

        configuration.label
            .frame(width: size, height: size)
            .padding(size == nil ? VSpacing.xs : 0)
            .background(shape.fill(backgroundColor(isPressed: configuration.isPressed)))
            .overlay(
                shape.strokeBorder(
                    borderColor,
                    lineWidth: borderLineWidth
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
        if case .filled(let color) = variant {
            guard isEnabled else { return color.opacity(0.5) }
            if isPressed { return color.opacity(0.7) }
            if isHovered { return color.opacity(0.85) }
            return color
        }
        if case .outlined = variant {
            if isPressed { return VColor.ghostPressed }
            if isHovered { return VColor.ghostHover }
            return .clear
        }
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

    private var borderLineWidth: CGFloat {
        if case .outlined = variant { return 2 }
        return isEnabled && isFocused ? 1.25 : 1
    }

    private var borderColor: Color {
        if case .filled = variant { return .clear }
        if case .outlined = variant {
            return VColor.buttonSecondaryBorder
        }
        guard isEnabled, isFocused else { return .clear }
        return VColor.accent.opacity(0.72)
    }
}

#Preview("VIconButton") {
    ZStack {
        VColor.background.ignoresSafeArea()
        HStack(spacing: 12) {
            VIconButton(label: "Settings", icon: VIcon.settings.rawValue) {}
            VIconButton(label: "Active", icon: VIcon.star.rawValue, isActive: true) {}
            VIconButton(label: "Icon Only", icon: VIcon.plus.rawValue, iconOnly: true) {}
            VIconButton(label: "Active Icon", icon: VIcon.pencil.rawValue, isActive: true, iconOnly: true) {}
            VIconButton(label: "Filled", icon: VIcon.ellipsis.rawValue, iconOnly: true, variant: .filled(VColor.buttonPrimary)) {}
            VIconButton(label: "Outlined", icon: VIcon.x.rawValue, iconOnly: true, variant: .outlined) {}
        }
        .padding()
    }
    .frame(width: 500, height: 80)
}
