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
                    .font(VFont.labelDefault)
                    .foregroundColor(VColor.contentTertiary)

                Text(data.name)
                    .font(VFont.mono)
                    .foregroundColor(VColor.contentDefault)

                Text(data.description)
                    .font(VFont.labelDefault)
                    .foregroundColor(VColor.contentSecondary)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(VColor.surfaceActive)
        .clipShape(PixelBorderShape())
        .overlay(
            PixelBorderShape()
                .stroke(VColor.borderActive.opacity(0.6), lineWidth: 2)
        )
    }
}
