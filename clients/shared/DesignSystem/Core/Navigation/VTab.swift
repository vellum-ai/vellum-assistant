import SwiftUI

public enum VTabStyle {
    case pill        // Shows background fill on selected/hover, fully rounded
    case flat        // No background fill, only text color changes
    case rectangular // Same as pill but with VRadius.md corners (matches VButton)
}

public struct VTab: View {
    public let label: String
    public var icon: String? = nil    // SF Symbol
    public var isSelected: Bool = false
    public var isCloseable: Bool = true
    public var style: VTabStyle = .pill
    public var onSelect: () -> Void
    public var onClose: (() -> Void)? = nil

    @State private var isHovered = false

    public init(label: String, icon: String? = nil, isSelected: Bool = false, isCloseable: Bool = true, style: VTabStyle = .pill, onSelect: @escaping () -> Void, onClose: (() -> Void)? = nil) {
        self.label = label
        self.icon = icon
        self.isSelected = isSelected
        self.isCloseable = isCloseable
        self.style = style
        self.onSelect = onSelect
        self.onClose = onClose
    }

    private var background: Color {
        if isSelected {
            return VColor.surfaceActive
        } else if isHovered {
            return VColor.surfaceBase
        } else {
            return VColor.surfaceBase.opacity(0)
        }
    }

    private var cornerRadius: CGFloat {
        return VRadius.md
    }

    public var body: some View {
        Button(action: onSelect) {
            HStack(spacing: VSpacing.xs) {
                if let icon = icon {
                    VIconView(.resolve(icon), size: 12)
                }
                Text(label)
                    .font(VFont.labelDefault)
                    .lineLimit(1)
                if isCloseable, onClose != nil {
                    Spacer().frame(width: 16)
                }
            }
            .foregroundStyle(isSelected && (style == .pill || style == .rectangular) ? VColor.contentDefault : (isSelected ? VColor.contentDefault : VColor.contentSecondary))
            .padding(.horizontal, VSpacing.lg)
            .frame(height: 32)
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius))
        }
        .buttonStyle(.plain)
        .overlay(alignment: .trailing) {
            if isCloseable, let onClose = onClose {
                Button(action: onClose) {
                    VIconView(.x, size: 10)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close \(label)")
                .padding(.trailing, VSpacing.sm)
            }
        }
        .background(background)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius)
                .stroke(VColor.borderBase, lineWidth: 1)
                .opacity(isSelected ? 1 : 0)
        )
        .animation(VAnimation.fast, value: isHovered)
        .onHover { hovering in isHovered = hovering }
        .pointerCursor()
    }
}

