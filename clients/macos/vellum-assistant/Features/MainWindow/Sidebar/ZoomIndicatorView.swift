import SwiftUI
import VellumAssistantShared

struct ZoomIndicatorView: View {
    let percentage: Int
    /// Optional prefix shown before the percentage (e.g. "Text" → "Text 125%").
    var label: String? = nil

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            if let label {
                Text(label)
                    .font(VFont.caption)
                    .foregroundStyle(VColor.textSecondary)
            }
            Text("\(percentage)%")
                .font(VFont.bodyMedium)
                .foregroundStyle(VColor.textPrimary)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .accessibilityLabel("Zoom \(percentage) percent")
    }
}
