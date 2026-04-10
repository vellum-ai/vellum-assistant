import SwiftUI
import VellumAssistantShared

/// Full-page detail view for a skill, showing metadata and a two-pane file
/// browser. Works for both installed skills (file contents delivered inline
/// with the file list) and uninstalled catalog skills (file contents fetched
/// lazily on click).
struct SkillDetailView: View {
    let skill: SkillInfo
    var skillsManager: SkillsManager
    let onBack: () -> Void
    let onDelete: (SkillInfo) -> Void

    @State private var expandedFilePath: String?
    @State private var expandedPaths: Set<String> = []
    @State private var didSeedExpandedPaths: Bool = false
    @State private var skillFileViewMode: FileViewMode = .source
    @State private var browserNodes: [VFileBrowserNode] = []
    /// Tracks the previously observed `skill.kind` so an install-from-preview
    /// transition (catalog → installed/bundled) can be detected and drive a
    /// refresh of the file tree with eagerly-loaded content.
    @State private var lastObservedKind: String = ""

    /// True when the skill is not installed locally, so file contents must be
    /// fetched lazily rather than delivered inline with the file list.
    private var isPreview: Bool { !skill.isInstalled }

    private var hasViewableFiles: Bool {
        guard let files = skillsManager.selectedSkillFiles else { return true }
        if isPreview {
            return files.files.contains { !$0.isBinary }
        }
        return files.files.contains { !$0.isBinary && $0.content != nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            SkillDetailTitleRow(
                skill: skill,
                isInstalling: skillsManager.installingSkillId == skill.id,
                onBack: onBack,
                onDelete: { onDelete(skill) },
                onInstall: { skillsManager.installSkill(slug: skill.id) }
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
            // Seed `lastObservedKind` with the current kind so a later flip
            // into "installed"/"bundled" is detected as a true transition
            // rather than as the initial layout for an already-installed skill.
            lastObservedKind = skill.kind
            skillsManager.fetchSkillFiles(skillId: skill.id)
        }
        .onChange(of: skill.kind) { _, newKind in
            // Detect an install-from-preview transition: when the kind flips
            // from "catalog" to "installed"/"bundled", the preview file list
            // (which has nil `content` fields served lazily) is now stale —
            // the backend now holds eagerly-loaded inline content for this
            // skill. Drop the lazy content cache and re-fetch so the file
            // tree transparently swaps in the full content without the user
            // having to navigate away and back.
            let becameInstalled = newKind == "installed" || newKind == "bundled"
            if becameInstalled && lastObservedKind == "catalog" {
                skillsManager.clearLoadedFileContents()
                skillsManager.fetchSkillFiles(skillId: skill.id)
            }
            lastObservedKind = newKind
        }
        .onChange(of: skillsManager.selectedSkillFiles?.files.map { "\($0.path):\($0.content == nil)" }) {
            // 1. Rebuild the browser node tree from the latest file list (moved out of
            //    view body per clients/AGENTS.md: no heavy transformation in body).
            //    In preview mode the `content` field is always nil — files are
            //    fetched lazily on click — so the tree filter must tolerate that.
            //    The key includes each file's content-nullness so the rebuild
            //    fires after an install-from-preview refresh, where the path
            //    list is unchanged but content transitions from null to inline.
            let textFiles: [SkillFileEntry]
            if let files = skillsManager.selectedSkillFiles?.files {
                textFiles = files.filter { file in
                    isPreview ? !file.isBinary : (!file.isBinary && file.content != nil)
                }
                browserNodes = Self.buildSkillNodeTree(from: textFiles)
            } else {
                textFiles = []
                browserNodes = []
            }

            // 2. Auto-select SKILL.md (or the first text file) on first load.
            if expandedFilePath == nil, let files = skillsManager.selectedSkillFiles?.files {
                let matchesTextFilter: (SkillFileEntry) -> Bool = { file in
                    isPreview ? !file.isBinary : (!file.isBinary && file.content != nil)
                }
                let skillMd = files.first { $0.path == "SKILL.md" && matchesTextFilter($0) }
                let firstText = files.first(where: matchesTextFilter)
                if let selectedFile = skillMd ?? firstText {
                    expandedFilePath = selectedFile.path
                    let autoModes = availableViewModes(for: selectedFile.path, mimeType: selectedFile.mimeType)
                    skillFileViewMode = autoModes.first ?? .source
                }
            }

            // 3. On the first fetch for this skill view, start with all folders
            //    collapsed. Only expand the ancestor chain of the auto-selected
            //    file so that file remains visible in the tree — for the common
            //    case where SKILL.md lives at the root, this is a no-op and every
            //    folder stays collapsed. On subsequent refetches (e.g. files
            //    re-fetched after an edit, a refresh button, or a file watcher),
            //    the `didSeedExpandedPaths` flag prevents re-seeding so manual
            //    expansions/collapses aren't clobbered. `didSeedExpandedPaths` is
            //    reset in `.onDisappear` alongside `expandedPaths`, so navigating
            //    to a different skill re-triggers the initial seeding.
            if !didSeedExpandedPaths && !textFiles.isEmpty {
                var newExpanded: Set<String> = []
                if let selectedPath = expandedFilePath {
                    newExpanded.formUnion(Self.ancestorPaths(of: selectedPath))
                }
                expandedPaths = newExpanded
                didSeedExpandedPaths = true
            }
        }
        .onChange(of: expandedFilePath) {
            if let selectedPath = expandedFilePath,
               let filesResponse = skillsManager.selectedSkillFiles,
               let file = filesResponse.files.first(where: { $0.path == selectedPath }) {
                expandedPaths.formUnion(Self.ancestorPaths(of: selectedPath))
                let selectedModes = availableViewModes(for: file.path, mimeType: file.mimeType)
                skillFileViewMode = selectedModes.first ?? .source

                // In preview mode the file list is served without inline
                // content, so kick off a lazy content fetch the first time a
                // text file is selected.
                if isPreview,
                   !file.isBinary,
                   skillsManager.loadedFileContents[selectedPath] == nil,
                   !skillsManager.loadingFilePaths.contains(selectedPath),
                   skillsManager.fileContentErrors[selectedPath] == nil {
                    skillsManager.loadSkillFileContent(skillId: skill.id, path: selectedPath)
                }
            }
        }
        .onDisappear {
            expandedFilePath = nil
            expandedPaths = []
            didSeedExpandedPaths = false
            browserNodes = []
            lastObservedKind = ""
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
            VStack(spacing: VSpacing.md) {
                VEmptyState(
                    title: "Failed to load files",
                    subtitle: error,
                    icon: VIcon.circleAlert.rawValue
                )
                retryButton(label: "Retry") {
                    skillsManager.fetchSkillFiles(skillId: skill.id)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VFileBrowser(
                rootNodes: browserNodes,
                expandedPaths: $expandedPaths,
                selectedPath: $expandedFilePath
            ) { selectedNode in
                fileContentPane(for: selectedNode)
            }
        }
    }

    @ViewBuilder
    private func fileContentPane(for selectedNode: VFileBrowserNode?) -> some View {
        if let selectedNode,
           let file = skillsManager.selectedSkillFiles?.files.first(where: { $0.path == selectedNode.path }) {
            if isPreview && !file.isBinary {
                previewFileContent(for: file, nodePath: selectedNode.path)
            } else if let content = file.content {
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
        } else {
            VEmptyState(
                title: hasViewableFiles ? "Select a file to view" : "No viewable files",
                icon: VIcon.fileText.rawValue
            )
        }
    }

    @ViewBuilder
    private func previewFileContent(for file: SkillFileEntry, nodePath: String) -> some View {
        if let content = skillsManager.loadedFileContents[nodePath] {
            FileContentView(
                fileName: file.path,
                mimeType: file.mimeType,
                content: .constant(content),
                viewMode: $skillFileViewMode,
                isActivelyEditing: .constant(false)
            )
        } else if skillsManager.loadingFilePaths.contains(nodePath) {
            VEmptyState(
                title: "Loading file...",
                icon: VIcon.fileText.rawValue
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay { ProgressView().controlSize(.small) }
        } else if let error = skillsManager.fileContentErrors[nodePath] {
            VStack(spacing: VSpacing.md) {
                VEmptyState(
                    title: "Failed to load file",
                    subtitle: error,
                    icon: VIcon.circleAlert.rawValue
                )
                retryButton(label: "Retry") {
                    skillsManager.loadSkillFileContent(skillId: skill.id, path: nodePath)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VEmptyState(
                title: hasViewableFiles ? "Select a file to view" : "No viewable files",
                icon: VIcon.fileText.rawValue
            )
        }
    }

    @ViewBuilder
    private func retryButton(label: String, action: @escaping () -> Void) -> some View {
        VButton(
            label: label,
            leftIcon: VIcon.refreshCw.rawValue,
            style: .outlined,
            action: action
        )
    }
}

// MARK: - Title Row

struct SkillDetailTitleRow: View {
    let skill: SkillInfo
    var isInstalling: Bool = false
    let onBack: () -> Void
    let onDelete: () -> Void
    let onInstall: () -> Void

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
                    } else {
                        VIconView(.puzzle, size: 20)
                            .foregroundStyle(VColor.contentTertiary)
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
            } else if skill.kind == "catalog" {
                if isInstalling {
                    VLoadingIndicator()
                        .accessibilityLabel("Installing skill")
                } else {
                    VButton(label: "Install", leftIcon: VIcon.arrowDownToLine.rawValue, style: .primary) {
                        onInstall()
                    }
                }
            }
        }
    }
}

