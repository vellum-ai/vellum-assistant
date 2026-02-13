import SwiftUI

enum VTabStyle {
    case pill        // Shows background fill on selected/hover, fully rounded
    case flat        // No background fill, only text color changes
    case rectangular // Same as pill but with VRadius.md corners (matches VButton)
}

struct VTab: View {
    let label: String
    var icon: String? = nil    // SF Symbol
    var isSelected: Bool = false
    var isCloseable: Bool = true
    var style: VTabStyle = .pill
    var onSelect: () -> Void
    var onClose: (() -> Void)? = nil

    @State private var isHovered = false

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

    var body: some View {
        HStack(spacing: 6) {
            HStack(spacing: VSpacing.xs) {
                if let icon = icon {
                    Image(systemName: icon)
                        .font(.system(size: 12))
                }
                Text(label)
                    .font(VFont.caption)
                    .lineLimit(1)
            }
            .foregroundColor(isSelected && (style == .pill || style == .rectangular) ? Slate._900 : (isSelected ? VColor.textPrimary : VColor.textSecondary))

            if isCloseable, let onClose = onClose {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(VColor.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close \(label)")
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .contentShape(RoundedRectangle(cornerRadius: cornerRadius))
        .onTapGesture { onSelect() }
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
