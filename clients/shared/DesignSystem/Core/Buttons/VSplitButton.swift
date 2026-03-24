import SwiftUI

public struct VSplitButton<MenuContent: View>: View {
    public let label: String
    public var icon: String?
    public var style: VButton.Style
    public var size: VButton.Size
    public var isDisabled: Bool
    public var accessibilityID: String?
    public let action: () -> Void
    @ViewBuilder public let menuContent: () -> MenuContent

    @State private var isPrimaryHovered = false
    @State private var isDropdownHovered = false

    public init(
        label: String,
        icon: String? = nil,
        style: VButton.Style = .primary,
        size: VButton.Size = .regular,
        isDisabled: Bool = false,
        accessibilityID: String? = nil,
        action: @escaping () -> Void,
        @ViewBuilder menuContent: @escaping () -> MenuContent
    ) {
        self.label = label
        self.icon = icon
        self.style = style
        self.size = size
        self.isDisabled = isDisabled
        self.accessibilityID = accessibilityID
        self.action = action
        self.menuContent = menuContent
    }

    /// Matches VButton's ButtonLayoutModifier: regular=32, compact/pill=24.
    private var zoneHeight: CGFloat { size == .regular ? 32 : 24 }
    /// Dropdown zone is square (width == height).
    private var dropdownWidth: CGFloat { zoneHeight }

    public var body: some View {
        let cornerRadius = VRadius.md
        let shape = RoundedRectangle(cornerRadius: cornerRadius)

        HStack(spacing: 0) {
            // Primary action zone
            Button(action: action) {
                HStack(spacing: VSpacing.sm) {
                    if let icon {
                        VIconView(.resolve(icon), size: 13)
                    }
                    Text(label)
                        .font(size == .regular ? VFont.bodyMediumDefault : VFont.labelDefault)
                }
                .foregroundStyle(foregroundColor)
                .padding(.horizontal, size == .regular ? VSpacing.md : VSpacing.sm)
                .frame(height: zoneHeight)
                .background(zoneBackgroundColor(isHovered: isPrimaryHovered))
            }
            .buttonStyle(.plain)
            .onHover { hovering in
                isPrimaryHovered = isDisabled ? false : hovering
            }
            .pointerCursor()

            // Divider
            divider

            // Dropdown zone — visual layer + invisible Menu overlay
            ZStack(alignment: .center) {
                // Visual layer: background + centered icon
                zoneBackgroundColor(isHovered: isDropdownHovered)
                    .frame(width: dropdownWidth, height: zoneHeight)

                VIconView(.chevronDown, size: 11)
                    .foregroundStyle(foregroundColor)
                    .frame(width: dropdownWidth, height: zoneHeight)
                    .allowsHitTesting(false)

                // Interactive layer: fills entire zone
                Menu {
                    menuContent()
                } label: {
                    Color.clear
                        .frame(width: dropdownWidth, height: zoneHeight)
                        .contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .accessibilityLabel("\(label) options")
            }
            .frame(width: dropdownWidth, height: zoneHeight)
            .clipped()
            .onHover { hovering in
                isDropdownHovered = isDisabled ? false : hovering
            }
            .pointerCursor()
        }
        .fixedSize()
        .clipShape(shape)
        .overlay(
            shape.strokeBorder(
                borderColor,
                lineWidth: borderLineWidth
            )
        )
        .contentShape(shape)
        .disabled(isDisabled)
        .accessibilityElement(children: .contain)
        .optionalSplitButtonAccessibilityID(accessibilityID)
        .animation(VAnimation.fast, value: isPrimaryHovered)
        .animation(VAnimation.fast, value: isDropdownHovered)
    }

    // MARK: - Divider

    @ViewBuilder
    private var divider: some View {
        switch style {
        case .primary, .danger:
            // For filled styles, pad the divider and fill behind it with the base color
            // so no transparency leaks through between the two zones
            ZStack {
                Rectangle()
                    .fill(filledBaseColor)
                    .frame(width: 1 + 2, height: zoneHeight) // 1px divider + 1px padding each side
                Rectangle()
                    .fill(VColor.auxWhite.opacity(0.3))
                    .frame(width: 1, height: zoneHeight)
            }
        case .outlined, .dangerOutline:
            Rectangle()
                .fill(borderColor)
                .frame(width: 1, height: zoneHeight)
        case .ghost, .dangerGhost:
            Rectangle()
                .fill(VColor.borderBase)
                .frame(width: 1, height: zoneHeight)
        case .contrast:
            Rectangle()
                .fill(VColor.auxWhite.opacity(0.3))
                .frame(width: 1, height: zoneHeight)
        }
    }

    // MARK: - Colors

    private var filledBaseColor: Color {
        switch style {
        case .primary: return VColor.primaryBase
        case .danger: return VColor.systemNegativeStrong
        default: return .clear
        }
    }

    private func zoneBackgroundColor(isHovered: Bool) -> Color {
        guard !isDisabled else {
            switch style {
            case .primary, .danger, .contrast:
                return VColor.primaryDisabled
            default:
                return .clear
            }
        }

        switch style {
        case .primary:
            return isHovered ? VColor.primaryHover : VColor.primaryBase
        case .danger:
            return isHovered ? VColor.systemNegativeHover : VColor.systemNegativeStrong
        case .outlined, .dangerOutline:
            return isHovered ? VColor.surfaceBase : .clear
        case .ghost, .dangerGhost:
            return isHovered ? VColor.surfaceBase : .clear
        case .contrast:
            return isHovered ? VColor.contentSecondary : VColor.contentDefault
        }
    }

    private var foregroundColor: Color {
        guard !isDisabled else { return VColor.contentDisabled }
        switch style {
        case .primary, .danger, .contrast:
            return VColor.auxWhite
        case .outlined, .ghost:
            return VColor.primaryBase
        case .dangerOutline, .dangerGhost:
            return VColor.systemNegativeStrong
        }
    }

    private var borderColor: Color {
        guard !isDisabled else {
            switch style {
            case .outlined, .dangerOutline, .ghost, .dangerGhost:
                return VColor.primaryDisabled
            default:
                return .clear
            }
        }
        switch style {
        case .outlined:
            return VColor.primaryBase
        case .dangerOutline:
            return VColor.systemNegativeStrong
        case .ghost:
            return VColor.borderBase
        case .dangerGhost:
            return VColor.borderBase
        default:
            return .clear
        }
    }

    private var borderLineWidth: CGFloat {
        switch style {
        case .outlined, .dangerOutline: return 2
        case .ghost, .dangerGhost: return 1
        default: return 0
        }
    }
}

private extension View {
    @ViewBuilder
    func optionalSplitButtonAccessibilityID(_ identifier: String?) -> some View {
        if let identifier {
            self.accessibilityIdentifier(identifier)
        } else {
            self
        }
    }
}
