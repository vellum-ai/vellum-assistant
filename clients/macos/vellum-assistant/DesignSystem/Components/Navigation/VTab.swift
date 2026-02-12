import SwiftUI

struct VTab: View {
    let label: String
    var icon: String? = nil    // SF Symbol
    var isSelected: Bool = false
    var isCloseable: Bool = true
    var onSelect: () -> Void
    var onClose: (() -> Void)? = nil

    @State private var isHovered = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: VSpacing.xs) {
                if let icon = icon {
                    Image(systemName: icon)
                        .font(.system(size: 12))
                }
                Text(label)
                    .font(VFont.body)
                    .lineLimit(1)
            }
            .foregroundColor(isSelected ? VColor.textPrimary : VColor.textSecondary)
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .background(isSelected ? VColor.surfaceBorder : (isHovered ? VColor.surfaceBorder.opacity(0.5) : .clear))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
        }
        .buttonStyle(.plain)
        .onHover { hovering in isHovered = hovering }
        .overlay(alignment: .trailing) {
            if isCloseable, let onClose = onClose, isHovered {
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
