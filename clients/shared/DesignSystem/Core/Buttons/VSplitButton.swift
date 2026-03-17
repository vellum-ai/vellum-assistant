import SwiftUI

public struct VSplitButton<MenuContent: View>: View {
    public let label: String
    public var icon: String?
    public var style: VButton.Style
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
        isDisabled: Bool = false,
        accessibilityID: String? = nil,
        action: @escaping () -> Void,
        @ViewBuilder menuContent: @escaping () -> MenuContent
    ) {
        self.label = label
        self.icon = icon
        self.style = style
        self.isDisabled = isDisabled
        self.accessibilityID = accessibilityID
        self.action = action
        self.menuContent = menuContent
    }

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
                        .font(VFont.bodyMedium)
                }
                .foregroundColor(foregroundColor)
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.buttonV)
                .frame(height: 32)
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
                    .frame(width: 32, height: 32)

                VIconView(.chevronDown, size: 11)
                    .foregroundColor(foregroundColor)
                    .frame(width: 32, height: 32)
                    .allowsHitTesting(false)

                // Interactive layer: fills entire zone
                Menu {
                    menuContent()
                } label: {
                    Color.clear
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
            }
            .frame(width: 32, height: 32)
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
                    .frame(width: 1 + 2, height: 32) // 1px divider + 1px padding each side
                Rectangle()
                    .fill(VColor.auxWhite.opacity(0.3))
                    .frame(width: 1, height: 32)
            }
        case .outlined, .dangerOutline:
            Rectangle()
                .fill(borderColor)
                .frame(width: 1, height: 32)
        case .ghost, .dangerGhost:
            Rectangle()
                .fill(VColor.borderBase)
                .frame(width: 1, height: 32)
        case .contrast:
            Rectangle()
                .fill(VColor.auxWhite.opacity(0.3))
                .frame(width: 1, height: 32)
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
