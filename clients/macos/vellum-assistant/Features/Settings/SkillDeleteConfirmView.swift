import SwiftUI
import VellumAssistantShared

struct SkillDeleteConfirmView: View {
    let skillName: String
    var onDelete: () -> Void
    var onCancel: () -> Void

    private var skillsDirDisplay: String {
        let skillsDir = VellumPaths.current.workspaceDir
            .appendingPathComponent("skills")
            .path
        let home = NSHomeDirectory()
        if skillsDir.hasPrefix(home + "/") {
            return "~" + skillsDir.dropFirst(home.count) + "/"
        }
        return skillsDir + "/"
    }

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            VStack(spacing: VSpacing.md) {
                Text("Delete Skill")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentDefault)

                Text("Are you sure you want to delete \"\(skillName)\"? This will remove it from \(skillsDirDisplay).")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
            }

            HStack(spacing: VSpacing.md) {
                VButton(label: "Cancel", style: .outlined) {
                    onCancel()
                }

                VButton(label: "Delete", style: .danger) {
                    onDelete()
                }
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 340)
        .background(VColor.surfaceOverlay)
    }
}
