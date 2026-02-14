import SwiftUI

struct SkillInvocationChip: View {
    let data: SkillInvocationData

    var body: some View {
        HStack(spacing: VSpacing.md) {
            if let emoji = data.emoji {
                Text(emoji)
                    .font(VFont.cardEmoji)
            }

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
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
        .background(Slate._800)
        .clipShape(PixelBorderShape())
        .overlay(
            PixelBorderShape()
                .stroke(Amber._600.opacity(0.6), lineWidth: 2)
        )
    }
}

#Preview("SkillInvocationChip") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: VSpacing.lg) {
            SkillInvocationChip(data: SkillInvocationData(
                name: "Summarize Page",
                emoji: "📝",
                description: "Summarize the contents of the current page"
            ))
            SkillInvocationChip(data: SkillInvocationData(
                name: "Start the Day",
                emoji: nil,
                description: "Morning routine skill"
            ))
        }
        .padding()
    }
    .frame(width: 400, height: 200)
}
