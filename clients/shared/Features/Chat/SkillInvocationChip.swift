import SwiftUI

public struct SkillInvocationChip: View {
    let data: SkillInvocationData

    public init(data: SkillInvocationData) {
        self.data = data
    }

    public var body: some View {
        HStack(spacing: VSpacing.md) {
            if let emoji = data.emoji {
                Text(emoji)
                    .font(VFont.cardEmoji)
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Using skill")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.textMuted)

                Text(data.name)
                    .font(VFont.mono)
                    .foregroundColor(VColor.textPrimary)

                Text(data.description)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(VColor.inputBackground)
        .clipShape(PixelBorderShape())
        .overlay(
            PixelBorderShape()
                .stroke(VColor.skillChipBorder.opacity(0.6), lineWidth: 2)
        )
    }
}
