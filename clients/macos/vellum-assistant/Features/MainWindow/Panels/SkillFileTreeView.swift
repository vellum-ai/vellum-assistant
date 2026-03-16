import SwiftUI
import VellumAssistantShared

/// Tree view for skill files — builds a folder hierarchy from flat SkillFileEntry paths
/// and renders it with FileTreeRowLabel. All folders expanded by default.
struct SkillFileTreeView: View {
    let files: [SkillFileEntry]
    @Binding var selectedFilePath: String?

    @State private var collapsedPaths: Set<String> = []
    // Using collapsedPaths (starts empty = all expanded) instead of expandedPaths
    // so that all directories are expanded by default without needing initialization.

    private struct FlatItem: Identifiable {
        let id: String
        let node: FileTreeNode
        let depth: Int
    }

    private var flattenedVisibleNodes: [FlatItem] {
        var result: [FlatItem] = []
        func walk(_ nodes: [FileTreeNode], depth: Int) {
            for node in nodes {
                result.append(FlatItem(id: node.path, node: node, depth: depth))
                if node.isDirectory && !collapsedPaths.contains(node.path) {
                    walk(node.children, depth: depth + 1)
                }
            }
        }
        walk(FileTreeNode.buildTree(from: files), depth: 0)
        return result
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(flattenedVisibleNodes) { item in
                let isSelected = selectedFilePath == item.node.path
                let isText = !item.node.isBinary && item.node.content != nil

                Button {
                    if item.node.isDirectory {
                        withAnimation(VAnimation.fast) {
                            if collapsedPaths.contains(item.node.path) {
                                collapsedPaths.remove(item.node.path)
                            } else {
                                collapsedPaths.insert(item.node.path)
                            }
                        }
                    } else {
                        withAnimation(VAnimation.fast) {
                            selectedFilePath = item.node.path
                        }
                    }
                } label: {
                    HStack(spacing: VSpacing.sm) {
                        FileTreeRowLabel(
                            name: item.node.name,
                            isDirectory: item.node.isDirectory,
                            isExpanded: item.node.isDirectory && !collapsedPaths.contains(item.node.path),
                            depth: item.depth,
                            fileIcon: fileIcon(for: item.node.mimeType ?? "application/octet-stream")
                        )

                        Spacer()

                        if !item.node.isDirectory {
                            Text(formatFileSize(item.node.size ?? 0))
                                .font(VFont.small)
                                .foregroundColor(VColor.contentTertiary)
                                .padding(.trailing, VSpacing.sm)
                        }
                    }
                    .contentShape(Rectangle())
                    .background(isSelected ? VColor.surfaceActive : Color.clear)
                }
                .buttonStyle(.plain)
                .disabled(!item.node.isDirectory && !isText)
            }
        }
    }

    private func fileIcon(for mimeType: String) -> VIcon {
        if mimeType.hasPrefix("image/") { return .image }
        if mimeType.hasPrefix("text/") { return .fileText }
        if mimeType == "application/json" || mimeType == "application/javascript" || mimeType == "application/typescript" { return .fileCode }
        return .file
    }

}
