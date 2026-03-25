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
    var isDimmed: Bool = false

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            // Expand/collapse chevron for directories, spacer for files
            if isDirectory {
                VIconView(isExpanded ? .chevronDown : .chevronRight, size: 9)
                    .foregroundStyle(VColor.contentTertiary)
                    .frame(width: 12)
            } else {
                Spacer().frame(width: 12)
            }

            // File or folder icon
            VIconView(isDirectory ? .folder : fileIcon, size: 12)
                .foregroundStyle(isDirectory ? VColor.primaryBase : VColor.contentSecondary)

            // Name label
            Text(name)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(isDimmed ? VColor.contentTertiary : VColor.contentDefault)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.leading, CGFloat(depth) * VSpacing.lg + VSpacing.sm)
        .padding(.trailing, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .frame(minWidth: minRowWidth, alignment: .leading)
        .opacity(isDimmed ? 0.6 : 1.0)
    }
}
