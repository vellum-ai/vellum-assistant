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
                    .foregroundStyle(VColor.contentSecondary)
            }
            Text("\(percentage)%")
                .font(VFont.bodyMedium)
                .foregroundStyle(VColor.contentDefault)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .accessibilityLabel("Zoom \(percentage) percent")
    }
}
