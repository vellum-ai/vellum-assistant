import SwiftUI

struct VIconButton: View {
    let label: String
    let icon: String          // SF Symbol name
    var isActive: Bool = false
    var iconOnly: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: VSpacing.xs) {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .medium))
                if !iconOnly {
                    Text(label)
                        .font(VFont.caption)
                }
            }
            .foregroundColor(isActive ? VColor.textPrimary : VColor.textSecondary)
            .padding(.horizontal, iconOnly ? VSpacing.md : VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .background(isActive ? VColor.surfaceBorder : .clear)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .stroke(isActive ? VColor.surfaceBorder : VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
