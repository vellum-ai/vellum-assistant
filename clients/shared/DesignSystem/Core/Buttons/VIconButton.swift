import SwiftUI

public enum VIconButtonVariant {
    case ghost
    case primary
    case secondary
    case danger
    case success
    case outlined
    case neutral
}

public struct VIconButton: View {
    public let label: String
    public var icon: String = ""
    public var customIcon: Image? = nil
    public var isActive: Bool = false
    public var iconOnly: Bool = false
    public var variant: VIconButtonVariant = .ghost
    public var size: CGFloat? = nil
    public var tooltip: String? = nil
    public let action: () -> Void

    @State private var isHovered = false
    @FocusState private var isFocused: Bool

    public init(label: String, icon: String = "", customIcon: Image? = nil, isActive: Bool = false, iconOnly: Bool = false, variant: VIconButtonVariant = .ghost, size: CGFloat? = nil, tooltip: String? = nil, action: @escaping () -> Void) {
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
        .pointerCursor(onHover: { hovering in
            isHovered = hovering
        })
        .accessibilityLabel(label)
        .modifier(OptionalHelpModifier(tooltip: tooltip))
    }

    private var iconForegroundForVariant: Color {
        switch variant {
        case .primary, .danger, .success, .neutral:
            return .white
        case .ghost, .secondary, .outlined:
            return iconForegroundColor
        }
    }

    private var iconForegroundColor: Color {
        if isActive {
            return VColor.activeIconForeground
        }
        return VColor.buttonSecondaryText
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

    public init(isActive: Bool = false, isHovered: Bool, isFocused: Bool = false, size: CGFloat? = nil, variant: VIconButtonVariant = .ghost) {
        self.isActive = isActive
        self.isHovered = isHovered
        self.isFocused = isFocused
        self.size = size
        self.variant = variant
    }

    public func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: VRadius.md)

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
    }

    private func backgroundColor(isPressed: Bool) -> Color {
        switch variant {
        case .primary:
            guard isEnabled else { return VColor.buttonPrimary.opacity(0.5) }
            if isPressed { return VColor.buttonPrimaryPressed }
            if isHovered { return VColor.buttonPrimaryHover }
            return VColor.buttonPrimary

        case .danger:
            guard isEnabled else { return VColor.buttonDanger.opacity(0.5) }
            if isPressed { return VColor.buttonDangerPressed }
            if isHovered { return VColor.buttonDangerHover }
            return VColor.buttonDanger

        case .success:
            guard isEnabled else { return VColor.buttonSuccessBg.opacity(0.5) }
            if isPressed { return VColor.buttonSuccessBgPressed }
            if isHovered { return VColor.buttonSuccessBgHover }
            return VColor.buttonSuccessBg

        case .neutral:
            guard isEnabled else { return VColor.buttonNeutral.opacity(0.5) }
            if isPressed { return VColor.buttonNeutralPressed }
            if isHovered { return VColor.buttonNeutralHover }
            return VColor.buttonNeutral

        case .secondary:
            guard isEnabled else { return VColor.buttonSecondaryBg.opacity(0.5) }
            if isPressed { return VColor.buttonSecondaryBgPressed }
            if isHovered { return VColor.buttonSecondaryBgHover }
            return VColor.buttonSecondaryBg

        case .outlined:
            if isPressed { return VColor.ghostPressed }
            if isHovered { return VColor.ghostHover }
            return .clear

        case .ghost:
            guard isEnabled else {
                return isActive ? VColor.iconGhostActiveDisabled.opacity(0.5) : .clear
            }
            if isActive {
                if isPressed { return VColor.iconGhostActivePressed }
                if isHovered { return VColor.iconGhostActivePressed }
                return VColor.iconGhostActiveBg
            } else {
                if isPressed { return VColor.iconGhostActivePressed }
                if isHovered { return VColor.iconGhostActiveBg }
                return .clear
            }
        }
    }

    private var borderLineWidth: CGFloat {
        if case .outlined = variant { return 2 }
        return isEnabled && isFocused ? 1.25 : 1
    }

    private var borderColor: Color {
        switch variant {
        case .primary, .danger, .success, .neutral:
            return .clear
        case .outlined:
            return VColor.buttonSecondaryBorder
        case .ghost, .secondary:
            guard isEnabled, isFocused else { return .clear }
            return VColor.accent.opacity(0.72)
        }
    }
}

#Preview("VIconButton") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: 16) {
            HStack(spacing: 12) {
                VIconButton(label: "Ghost", icon: VIcon.settings.rawValue) {}
                VIconButton(label: "Active", icon: VIcon.star.rawValue, isActive: true) {}
                VIconButton(label: "Icon Only", icon: VIcon.plus.rawValue, iconOnly: true) {}
                VIconButton(label: "Active Icon", icon: VIcon.pencil.rawValue, isActive: true, iconOnly: true) {}
            }
            HStack(spacing: 12) {
                VIconButton(label: "Primary", icon: VIcon.ellipsis.rawValue, iconOnly: true, variant: .primary) {}
                VIconButton(label: "Danger", icon: VIcon.x.rawValue, iconOnly: true, variant: .danger) {}
                VIconButton(label: "Neutral", icon: VIcon.square.rawValue, iconOnly: true, variant: .neutral) {}
                VIconButton(label: "Secondary", icon: VIcon.arrowUp.rawValue, iconOnly: true, variant: .secondary) {}
                VIconButton(label: "Outlined", icon: VIcon.x.rawValue, iconOnly: true, variant: .outlined) {}
            }
        }
        .padding()
    }
    .frame(width: 500, height: 140)
}
