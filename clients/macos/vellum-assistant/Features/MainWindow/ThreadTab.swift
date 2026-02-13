import SwiftUI

/// A thread tab component that renders a tab with thread-specific styling.
/// When selected, shows white text with no background or border.
/// Composes `VTab`-like structure with thread appearance baked in.
struct ThreadTab: View {
    let label: String
    var icon: String? = nil    // SF Symbol
    var isSelected: Bool = false
    var isCloseable: Bool = true
    var onSelect: () -> Void
    var onClose: (() -> Void)? = nil

    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 6) {
            Button(action: onSelect) {
                HStack(spacing: VSpacing.xs) {
                    if let icon = icon {
                        Image(systemName: icon)
                            .font(.system(size: 12))
                    }
                    Text(label)
                        .font(VFont.tabLabel)
                        .lineLimit(1)
                }
                .foregroundColor(isSelected ? Color(hex: 0xFFFFFF) : VColor.textSecondary)
            }
            .buttonStyle(.plain)

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
        .background(isHovered && !isSelected ? VColor.surfaceBorder.opacity(0.5) : .clear)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .onHover { hovering in isHovered = hovering }
    }
}

#Preview("ThreadTab") {
    ZStack {
        VColor.background.ignoresSafeArea()
        HStack(spacing: 8) {
            ThreadTab(label: "Thread 1", icon: "flame", isSelected: true, onSelect: {})
            ThreadTab(label: "Thread 2", icon: "flame", isSelected: false, onSelect: {}, onClose: {})
            ThreadTab(label: "Thread 3", icon: "flame", isCloseable: false, onSelect: {})
        }
        .padding()
    }
    .frame(width: 500, height: 80)
}
