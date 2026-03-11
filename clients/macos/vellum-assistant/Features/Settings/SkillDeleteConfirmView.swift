import SwiftUI
import VellumAssistantShared

struct SkillDeleteConfirmView: View {
    let skillName: String
    var onDelete: () -> Void
    var onCancel: () -> Void

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            VStack(spacing: VSpacing.md) {
                Text("Delete Skill")
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)

                Text("Are you sure you want to delete \"\(skillName)\"? This will remove it from ~/.vellum/workspace/skills/.")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
            }

            HStack(spacing: VSpacing.md) {
                VButton(label: "Cancel", style: .tertiary, size: .medium) {
                    onCancel()
                }

                VButton(label: "Delete", style: .danger, size: .medium) {
                    onDelete()
                }
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 340)
        .background(VColor.background)
    }
}
