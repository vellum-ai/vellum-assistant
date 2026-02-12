import SwiftUI

enum VTabStyle {
    case pill   // Shows background fill on selected/hover
    case flat   // No background fill, only text color changes
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
        case .pill:
            return isSelected ? Slate._200 : (isHovered ? VColor.surfaceBorder.opacity(0.5) : .clear)
        case .flat:
            return .clear
        }
    }

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: VSpacing.xs) {
                if let icon = icon {
                    Image(systemName: icon)
                        .font(.system(size: 12))
                }
                Text(label)
                    .font(VFont.caption)
                    .lineLimit(1)
            }
            .foregroundColor(isSelected && style == .pill ? Slate._900 : (isSelected ? VColor.textPrimary : VColor.textSecondary))
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .background(background)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.pill)
                    .stroke(Slate._300, lineWidth: 1)
                    .opacity(style == .pill && isSelected ? 1 : 0)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering in isHovered = hovering }
        .overlay(alignment: .trailing) {
            if isCloseable, let onClose = onClose {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(VColor.textMuted)
                        .padding(.trailing, VSpacing.xs)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close \(label)")
            }
        }
    }
}

#Preview("VTab") {
    ZStack {
        VColor.background.ignoresSafeArea()
        HStack(spacing: 8) {
            VTab(label: "Dashboard", icon: "house", isSelected: true, onSelect: {})
            VTab(label: "Settings", icon: "gear", onSelect: {})
            VTab(label: "Not closeable", isCloseable: false, onSelect: {})
        }
        .padding()
    }
    .frame(width: 450, height: 80)
}
