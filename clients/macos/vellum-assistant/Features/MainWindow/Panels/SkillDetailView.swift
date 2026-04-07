import SwiftUI
import VellumAssistantShared

/// Full-page detail view for an installed skill, showing metadata and a two-pane file browser.
struct SkillDetailView: View {
    let skill: SkillInfo
    var skillsManager: SkillsManager
    let onBack: () -> Void
    let onDelete: (SkillInfo) -> Void

    @State private var expandedFilePath: String?
    @State private var expandedPaths: Set<String> = []
    @State private var skillFileViewMode: FileViewMode = .source
    @State private var browserNodes: [VFileBrowserNode] = []

    private var hasViewableFiles: Bool {
        guard let files = skillsManager.selectedSkillFiles else { return true }
        return files.files.contains { !$0.isBinary && $0.content != nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            SkillDetailTitleRow(
                skill: skill,
                onBack: onBack,
                onDelete: { onDelete(skill) }
            )

            if !skill.description.isEmpty {
                Text(skill.description)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(8)
                    .frame(maxWidth: 800, alignment: .leading)
            }
            originMetaRow
            skillDetailFileBrowser
        }
        .onAppear {
            // Only fetch files for locally available skills (bundled or installed).
            // Remote catalog search results are not in the local resolved catalog, so
            // GET /skills/:id/files would 404 for them.
            if skill.isInstalled {
                skillsManager.fetchSkillFiles(skillId: skill.id)
            }
        }
        .onChange(of: skillsManager.selectedSkillFiles?.files.map(\.path)) {
            // 1. Rebuild the browser node tree from the latest file list (moved out of
            //    view body per clients/AGENTS.md: no heavy transformation in body).
            if let files = skillsManager.selectedSkillFiles?.files {
                let textFiles = files.filter { !$0.isBinary && $0.content != nil }
                browserNodes = Self.buildSkillNodeTree(from: textFiles)
            } else {
                browserNodes = []
            }

            // 2. Auto-select SKILL.md (or the first text file) on first load.
            if expandedFilePath == nil, let files = skillsManager.selectedSkillFiles?.files {
                let skillMd = files.first { $0.path == "SKILL.md" && !$0.isBinary && $0.content != nil }
                let firstText = files.first { !$0.isBinary && $0.content != nil }
                if let selectedFile = skillMd ?? firstText {
                    expandedFilePath = selectedFile.path
                    let autoModes = availableViewModes(for: selectedFile.path, mimeType: selectedFile.mimeType)
                    skillFileViewMode = autoModes.first ?? .source
                }
            }

            // 3. Expand every directory in the tree so nested files are visible by
            //    default. This preserves the previous flat-list behavior where all
            //    files were immediately visible. Also union the selected file's
            //    ancestors as a defensive no-op (already a subset of the above).
            if let files = skillsManager.selectedSkillFiles?.files {
                var newExpanded = Self.allDirectoryPaths(in: files)
                if let selectedPath = expandedFilePath {
                    newExpanded.formUnion(Self.ancestorPaths(of: selectedPath))
                }
                expandedPaths = newExpanded
            }
        }
        .onChange(of: expandedFilePath) {
            if let selectedPath = expandedFilePath,
               let filesResponse = skillsManager.selectedSkillFiles,
               let file = filesResponse.files.first(where: { $0.path == selectedPath }) {
                expandedPaths.formUnion(Self.ancestorPaths(of: selectedPath))
                let selectedModes = availableViewModes(for: file.path, mimeType: file.mimeType)
                skillFileViewMode = selectedModes.first ?? .source
            }
        }
        .onDisappear {
            expandedFilePath = nil
            expandedPaths = []
            browserNodes = []
            skillsManager.clearSkillDetail()
        }
    }

    // MARK: - Path helpers

    /// Returns all ancestor folder paths of a file (or nested folder) path.
    /// E.g. `ancestorPaths(of: "a/b/c.md")` returns `["a", "a/b"]`.
    private static func ancestorPaths(of path: String) -> Set<String> {
        let components = path.split(separator: "/").map(String.init)
        guard components.count > 1 else { return [] }
        var result: Set<String> = []
        for i in 1..<components.count {
            result.insert(components[0..<i].joined(separator: "/"))
        }
        return result
    }

    /// Returns every directory path present in a flat list of skill files.
    /// E.g. a file `external/asana/asana.md` contributes `external` and
    /// `external/asana` to the resulting set.
    private static func allDirectoryPaths(in files: [SkillFileEntry]) -> Set<String> {
        var result: Set<String> = []
        for file in files {
            let components = file.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
            guard components.count > 1 else { continue }
            for i in 1..<components.count {
                result.insert(components[0..<i].joined(separator: "/"))
            }
        }
        return result
    }

    // MARK: - Origin-Specific Metadata

    @ViewBuilder
    private var originMetaRow: some View {
        switch skill.originMeta {
        case .clawhub(let meta):
            HStack(spacing: VSpacing.lg) {
                if !meta.author.isEmpty {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.user, size: 12)
                        Text(meta.author)
                            .font(VFont.labelDefault)
                    }
                    .foregroundStyle(VColor.contentTertiary)
                }
                if meta.stars > 0 {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.star, size: 12)
                        Text("\(meta.stars)")
                            .font(VFont.labelDefault)
                    }
                    .foregroundStyle(VColor.contentTertiary)
                }
                if meta.installs > 0 {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.arrowDownToLine, size: 12)
                        Text("\(meta.installs)")
                            .font(VFont.labelDefault)
                    }
                    .foregroundStyle(VColor.contentTertiary)
                }
            }
        case .skillssh(let meta):
            HStack(spacing: VSpacing.lg) {
                if !meta.sourceRepo.isEmpty {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.gitBranch, size: 12)
                        Text(meta.sourceRepo)
                            .font(VFont.labelDefault)
                    }
                    .foregroundStyle(VColor.contentTertiary)
                }
                if meta.installs > 0 {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.arrowDownToLine, size: 12)
                        Text("\(meta.installs)")
                            .font(VFont.labelDefault)
                    }
                    .foregroundStyle(VColor.contentTertiary)
                }
            }
        case .vellum, .custom:
            EmptyView()
        }
    }

    // MARK: - File Browser

    /// Build a sorted `[VFileBrowserNode]` tree from a flat list of skill files.
    /// Sorting: directories first (alphabetical), then files (alphabetical).
    private static func buildSkillNodeTree(from files: [SkillFileEntry]) -> [VFileBrowserNode] {
        var childrenByParent: [String: [VFileBrowserNode]] = [:]
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
                let dirNode = VFileBrowserNode(
                    id: dirPath,
                    name: components[i],
                    path: dirPath,
                    isDirectory: true
                )
                childrenByParent[parentPath, default: []].append(dirNode)
            }

            // Create file leaf node
            let parentPath = components.count == 1 ? "" : components[0..<(components.count - 1)].joined(separator: "/")
            let fileNode = VFileBrowserNode(
                id: file.path,
                name: file.name,
                path: file.path,
                isDirectory: false,
                size: file.size,
                icon: fileIcon(for: file.mimeType, fileName: file.name)
            )
            childrenByParent[parentPath, default: []].append(fileNode)
        }

        func buildChildren(forParent parentPath: String) -> [VFileBrowserNode] {
            guard var nodes = childrenByParent[parentPath] else { return [] }
            nodes = nodes.map { node in
                guard node.isDirectory else { return node }
                var dirNode = node
                dirNode.children = buildChildren(forParent: node.path)
                return dirNode
            }
            nodes.sort { a, b in
                if a.isDirectory != b.isDirectory { return a.isDirectory }
                return a.name.localizedStandardCompare(b.name) == .orderedAscending
            }
            return nodes
        }

        return buildChildren(forParent: "")
    }

    @ViewBuilder
    private var skillDetailFileBrowser: some View {
        if skillsManager.isLoadingSkillFiles {
            VEmptyState(
                title: "Loading files...",
                icon: VIcon.fileText.rawValue
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay { ProgressView().controlSize(.small) }
        } else if let error = skillsManager.skillFilesError {
            VEmptyState(
                title: "Failed to load files",
                subtitle: error,
                icon: VIcon.circleAlert.rawValue
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VFileBrowser(
                rootNodes: browserNodes,
                expandedPaths: $expandedPaths,
                selectedPath: $expandedFilePath
            ) { selectedNode in
                if let selectedNode,
                   let file = skillsManager.selectedSkillFiles?.files.first(where: { $0.path == selectedNode.path }),
                   let content = file.content {
                    FileContentView(
                        fileName: file.path,
                        mimeType: file.mimeType,
                        content: .constant(content),
                        viewMode: $skillFileViewMode,
                        isActivelyEditing: .constant(false)
                    )
                } else {
                    VEmptyState(
                        title: hasViewableFiles ? "Select a file to view" : "No viewable files",
                        icon: VIcon.fileText.rawValue
                    )
                }
            }
        }
    }
}

// MARK: - Title Row

struct SkillDetailTitleRow: View {
    let skill: SkillInfo
    let onBack: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack {
            HStack(spacing: VSpacing.lg) {
                VButton(
                    label: "Back",
                    iconOnly: VIcon.arrowLeft.rawValue,
                    style: .outlined,
                    tooltip: "Back to Skills"
                ) {
                    onBack()
                }
                .frame(width: 32, height: 32)

                HStack(spacing: VSpacing.sm) {
                    if let emoji = skill.emoji, !emoji.isEmpty {
                        Text(emoji)
                            .font(.system(size: 20))
                    }

                    Text(skill.name)
                        .font(VFont.titleMedium)
                        .foregroundStyle(VColor.contentEmphasized)
                        .lineLimit(1)
                }

            }

            Spacer()

            VSkillTypePill(origin: skill.origin)

            if skill.kind == "installed" {
                VButton(label: "Remove", leftIcon: VIcon.trash.rawValue, style: .dangerOutline) {
                    onDelete()
                }
            }
        }
    }
}

