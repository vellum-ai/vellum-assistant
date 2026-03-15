import SwiftUI
import VellumAssistantShared

/// Shared row label for file tree views — renders indentation, expand/collapse chevron,
/// file/folder icon, and name. Used by both SkillFileTreeView and WorkspaceTreeRow.
struct FileTreeRowLabel: View {
    let name: String
    let isDirectory: Bool
    let isExpanded: Bool
    let depth: Int
    let fileIcon: VIcon
    var minRowWidth: CGFloat = 0

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            // Expand/collapse chevron for directories, spacer for files
            if isDirectory {
                VIconView(isExpanded ? .chevronDown : .chevronRight, size: 9)
                    .foregroundColor(VColor.contentTertiary)
                    .frame(width: 12)
            } else {
                Spacer().frame(width: 12)
            }

            // File or folder icon
            VIconView(isDirectory ? .folder : fileIcon, size: 12)
                .foregroundColor(isDirectory ? VColor.primaryBase : VColor.contentSecondary)

            // Name label
            Text(name)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.leading, CGFloat(depth) * 16 + VSpacing.sm)
        .padding(.trailing, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .frame(minWidth: minRowWidth, alignment: .leading)
    }
}
