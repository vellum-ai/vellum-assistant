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
        HStack(spacing: VSpacing.xs) {
            if let icon = icon {
                Image(systemName: icon)
                    .font(.system(size: 10))
            }
            Text(label)
                .font(VFont.caption)
                .lineLimit(1)
            if isCloseable, let onClose = onClose {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundColor(VColor.textMuted)
                }
                .buttonStyle(.plain)
                .opacity(isHovered ? 1 : 0)
            }
        }
        .foregroundColor(isSelected ? VColor.textPrimary : VColor.textSecondary)
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(isSelected ? VColor.surfaceBorder : (isHovered ? VColor.surfaceBorder.opacity(0.5) : .clear))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .onHover { hovering in isHovered = hovering }
        .onTapGesture { onSelect() }
    }
}
