import SwiftUI
import VellumAssistantShared

/// Shared row label for file tree views — renders indentation, expand/collapse chevron,
/// file/folder icon, and name. Used by WorkspaceTreeRow.
struct FileTreeRowLabel: View {
    let name: String
    let isDirectory: Bool
    let isExpanded: Bool
    let depth: Int
    let fileIcon: VIcon
    var minRowWidth: CGFloat = 0
    var isDimmed: Bool = false
    var isActive: Bool = false
    var trailingText: String? = nil

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
                .foregroundStyle(isActive ? VColor.primaryActive : VColor.primaryBase)

            // Name label
            Text(name)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(
                    isDimmed ? VColor.contentTertiary :
                    isActive ? VColor.contentEmphasized :
                    VColor.contentSecondary
                )
                .fixedSize(horizontal: true, vertical: false)

            // Trailing text (e.g. file size)
            if let trailingText {
                Spacer()
                Text(trailingText)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
        .padding(.leading, CGFloat(depth) * VSpacing.lg + VSpacing.sm)
        .padding(.trailing, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .frame(minWidth: minRowWidth, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(isActive ? VColor.surfaceActive : Color.clear)
        )
        .opacity(isDimmed ? 0.6 : 1.0)
    }
}
