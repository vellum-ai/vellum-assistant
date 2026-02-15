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
        switch style {
        case .pill, .rectangular:
            return isSelected ? Slate._200 : (isHovered ? VColor.surfaceBorder.opacity(0.5) : .clear)
        case .flat:
            return isHovered ? Slate._800 : .clear
        }
    }

    private var cornerRadius: CGFloat {
        switch style {
        case .pill, .flat: return VRadius.pill
        case .rectangular: return VRadius.md
        }
    }

    public var body: some View {
        Button(action: onSelect) {
            HStack(spacing: VSpacing.xs) {
                if let icon = icon {
                    Image(systemName: icon)
                        .font(.system(size: 12))
                }
                Text(label)
                    .font(VFont.caption)
                    .lineLimit(1)
                if isCloseable, onClose != nil {
                    Spacer().frame(width: 16)
                }
            }
            .foregroundColor(isSelected && (style == .pill || style == .rectangular) ? Slate._900 : (isSelected ? VColor.textPrimary : VColor.textSecondary))
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius))
        }
        .buttonStyle(.plain)
        .overlay(alignment: .trailing) {
            if isCloseable, let onClose = onClose {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(VColor.textMuted)
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
                .stroke(Slate._300, lineWidth: 1)
                .opacity((style == .pill || style == .rectangular) && isSelected ? 1 : 0)
        )
        .onHover { hovering in isHovered = hovering }
    }
}

#Preview("VTab") {
    ZStack {
        VColor.background.ignoresSafeArea()
        HStack(spacing: 8) {
            VTab(label: "Dashboard", icon: "house", isSelected: true, onSelect: {})
            VTab(label: "Settings", icon: "gear", onSelect: {})
            VTab(label: "Thread", icon: "plus", isCloseable: false, style: .rectangular, onSelect: {})
        }
        .padding()
    }
    .frame(width: 450, height: 80)
}
