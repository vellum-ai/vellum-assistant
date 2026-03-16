import Foundation
import VellumAssistantShared

/// A node in a file tree — either a directory (with children) or a file (leaf).
struct FileTreeNode: Identifiable {
    let id: String
    let name: String
    let path: String
    let isDirectory: Bool
    let size: Int?
    let mimeType: String?
    let isBinary: Bool
    let content: String?
    var children: [FileTreeNode]
}

extension FileTreeNode {
    /// Build a sorted tree from a flat list of SkillFileEntry paths.
    /// Directories are sorted before files; both alphabetically within each group.
    static func buildTree(from files: [SkillFileEntry]) -> [FileTreeNode] {
        // Dictionary mapping parent path -> list of child nodes
        var childrenByParent: [String: [FileTreeNode]] = [:]
        // Track which directory paths have been created
        var createdDirs: Set<String> = []

        for file in files {
            let components = file.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
            guard !components.isEmpty else { continue }

            // Create intermediate directory nodes for components 0..(N-2)
            for i in 0..<(components.count - 1) {
                let dirPath = components[0...i].joined(separator: "/")
                guard !createdDirs.contains(dirPath) else { continue }
                createdDirs.insert(dirPath)

                let parentPath = i == 0 ? "" : components[0..<i].joined(separator: "/")
                let dirNode = FileTreeNode(
                    id: dirPath,
                    name: components[i],
                    path: dirPath,
                    isDirectory: true,
                    size: nil,
                    mimeType: nil,
                    isBinary: false,
                    content: nil,
                    children: []
                )
                childrenByParent[parentPath, default: []].append(dirNode)
            }

            // Create file leaf node
            let parentPath = components.count == 1 ? "" : components[0..<(components.count - 1)].joined(separator: "/")
            let fileNode = FileTreeNode(
                id: file.path,
                name: file.name,
                path: file.path,
                isDirectory: false,
                size: file.size,
                mimeType: file.mimeType,
                isBinary: file.isBinary,
                content: file.content,
                children: []
            )
            childrenByParent[parentPath, default: []].append(fileNode)
        }

        // Recursively attach children and sort
        func buildChildren(forParent parentPath: String) -> [FileTreeNode] {
            guard var nodes = childrenByParent[parentPath] else { return [] }
            // For directories, recursively attach their children
            nodes = nodes.map { node in
                guard node.isDirectory else { return node }
                var dirNode = node
                dirNode.children = buildChildren(forParent: node.path)
                return dirNode
            }
            // Sort: directories first (alphabetical), then files (alphabetical)
            nodes.sort { a, b in
                if a.isDirectory != b.isDirectory {
                    return a.isDirectory
                }
                return a.name.localizedStandardCompare(b.name) == .orderedAscending
            }
            return nodes
        }

        return buildChildren(forParent: "")
    }
}
