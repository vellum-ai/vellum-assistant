import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared
#if os(macOS)
import AVKit
#endif

// MARK: - State Model

@MainActor @Observable
final class WorkspaceBrowserState {
    var directoryCache: [String: [WorkspaceTreeEntry]] = [:]
    var expandedDirs: Set<String> = []
    var selectedFilePath: String?
    var selectedFileDetail: WorkspaceFileResponse?
    var isLoadingTree = false
    var isLoadingFile = false
    var fileLoadTask: Task<Void, Never>?
    var isDropTargeted: Bool = false
    var uploadingCount: Int = 0
    var editableContent: String = ""
    var originalContent: String = ""
    var isDirty: Bool = false
    var isSaving: Bool = false
    var showingNewFileAlert = false
    var showingNewFolderAlert = false
    var newItemName: String = ""
    var newItemParentPath: String = ""
    var deleteConfirmPath: String?
    var deleteConfirmName: String = ""
    var renamingPath: String? = nil
    var renamingText: String = ""
    var pendingSwitchPath: String?
    var pendingHiddenFilesToggle: Bool?
    var showingDirtyAlert: Bool = false
    var viewMode: FileViewMode = .source
    var isActivelyEditing: Bool = false
    var showHiddenFiles: Bool = UserDefaults.standard.bool(forKey: "showHiddenFiles")
    var hiddenFilesToggleRequestId: UInt64 = 0

    /// Picks the initial view mode for a freshly-loaded file based on its
    /// extension and the user's stored preference. Pure function so it can be
    /// unit tested without spinning up a real workspace client. Called from
    /// `loadFile(path:using:)`.
    static func defaultViewMode(forExtension ext: String, prefersSource: Bool) -> FileViewMode {
        if prefersSource { return .source }
        switch ext {
        case "md", "markdown":
            return .preview
        case "json", "jsonl", "ndjson":
            return .tree
        default:
            return .source
        }
    }

    func refreshDirectory(_ dirPath: String, using workspaceClient: any WorkspaceClientProtocol) async {
        if let response = await workspaceClient.fetchWorkspaceTree(path: dirPath, showHidden: showHiddenFiles) {
            directoryCache[dirPath] = response.entries
        }
    }

    func loadFile(path targetPath: String, using workspaceClient: any WorkspaceClientProtocol) async {
        selectedFilePath = targetPath
        let ext = (targetPath as NSString).pathExtension.lowercased()
        let prefersSource = UserDefaults.standard.string(forKey: "fileViewerPreferredMode") == "source"
        viewMode = Self.defaultViewMode(forExtension: ext, prefersSource: prefersSource)
        isLoadingFile = true
        selectedFileDetail = nil
        isDirty = false
        isActivelyEditing = false
        editableContent = ""
        fileLoadTask?.cancel()
        let task = Task {
            let detail = await workspaceClient.fetchWorkspaceFile(path: targetPath, showHidden: showHiddenFiles)
            guard !Task.isCancelled, selectedFilePath == targetPath else { return }
            let raw = detail?.content ?? ""
            let mime = normalizedMimeType(detail?.mimeType ?? "")
            let isJSONL = isJSONLContent(fileName: detail?.name ?? targetPath, mimeType: mime)
            let isJSON = !isJSONL && (ext == "json" || mime.hasPrefix("application/json"))
            // JSONL is intentionally NOT pretty-printed — each line is already a
            // standalone JSON value, and reflowing the file would corrupt the
            // format. We do still want JSONL files to default to the tree view.
            let content = isJSON ? Self.prettyPrintJSON(raw) : raw
            if (isJSON || isJSONL), !prefersSource, viewMode != .tree {
                viewMode = .tree
            }
            editableContent = content
            originalContent = content
            isDirty = false
            isSaving = false

            // Sync view mode using MIME type from the response, respecting
            // the user's saved preference that was already applied above.
            if let detail {
                let modes = availableViewModes(for: detail.name, mimeType: detail.mimeType)
                if !modes.contains(viewMode) {
                    viewMode = modes.first ?? .source
                }
            }

            // Set selectedFileDetail before clearing isLoadingFile so the
            // view transitions directly from the loading spinner to file
            // content, never briefly falling through to the empty state.
            selectedFileDetail = detail
            isLoadingFile = false
        }
        fileLoadTask = task
    }

    /// Returns a pretty-printed version of `text`, falling back to the
    /// original string on any JSON parse error.
    private static func prettyPrintJSON(_ text: String) -> String {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed),
              let pretty = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .withoutEscapingSlashes]),
              let result = String(data: pretty, encoding: .utf8) else {
            return text
        }
        return result
    }
}

// MARK: - Workspace Panel

struct WorkspacePanel: View {
    @Binding var pendingFilePath: String?
    @State private var state = WorkspaceBrowserState()
    let workspaceClient = WorkspaceClient()
    @State private var sidebarWidth: CGFloat = 300
    @State private var dragStartWidth: CGFloat?
    @State private var didPushResizeCursor = false

    private let minSidebarWidth: CGFloat = 140
    private let maxSidebarWidth: CGFloat = 500

    private let dragCoordinateSpace = "WorkspacePanelDrag"

    init(pendingFilePath: Binding<String?> = .constant(nil)) {
        _pendingFilePath = pendingFilePath
    }

    var body: some View {
        HStack(spacing: 0) {
            WorkspaceTreeSidebar(state: state, workspaceClient: workspaceClient, onToggleHiddenFiles: applyHiddenFilesToggle)
                .frame(width: sidebarWidth)

            // Invisible resize handle
            Color.clear
                .frame(width: 6)
                .contentShape(Rectangle())
                .onHover { hovering in
                    if hovering {
                        NSCursor.resizeLeftRight.push()
                        didPushResizeCursor = true
                    } else if didPushResizeCursor {
                        NSCursor.pop()
                        didPushResizeCursor = false
                    }
                }
                .onDisappear {
                    if didPushResizeCursor {
                        NSCursor.pop()
                        didPushResizeCursor = false
                    }
                }
                .gesture(
                    DragGesture(minimumDistance: 1, coordinateSpace: .named(dragCoordinateSpace))
                        .onChanged { value in
                            if dragStartWidth == nil { dragStartWidth = sidebarWidth }
                            guard let start = dragStartWidth else { return }
                            let delta = value.location.x - value.startLocation.x
                            var transaction = Transaction()
                            transaction.disablesAnimations = true
                            withTransaction(transaction) {
                                sidebarWidth = min(max(start + delta, minSidebarWidth), maxSidebarWidth)
                            }
                        }
                        .onEnded { _ in
                            dragStartWidth = nil
                        }
                )

            WorkspaceFileViewer(state: state, workspaceClient: workspaceClient)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .coordinateSpace(name: dragCoordinateSpace)
        .task { await loadRoot() }
        .onChange(of: pendingFilePath) {
            if let path = pendingFilePath {
                pendingFilePath = nil
                Task { await state.loadFile(path: path, using: workspaceClient) }
            }
        }
        .onDisappear {
            state.fileLoadTask?.cancel()
            state.fileLoadTask = nil
            state.isLoadingFile = false
        }
        .alert(
            "Unsaved Changes",
            isPresented: $state.showingDirtyAlert
        ) {
            Button("Discard", role: .destructive) {
                if let targetPath = state.pendingSwitchPath {
                    state.pendingSwitchPath = nil
                    Task { await state.loadFile(path: targetPath, using: workspaceClient) }
                } else if let newValue = state.pendingHiddenFilesToggle {
                    state.pendingHiddenFilesToggle = nil
                    applyHiddenFilesToggle(newValue)
                }
            }
            Button("Cancel", role: .cancel) {
                state.pendingSwitchPath = nil
                state.pendingHiddenFilesToggle = nil
            }
        } message: {
            Text("You have unsaved changes. Discard them?")
        }
        .alert(
            "Delete \"\(state.deleteConfirmName)\"?",
            isPresented: Binding(
                get: { state.deleteConfirmPath != nil },
                set: { if !$0 { state.deleteConfirmPath = nil } }
            )
        ) {
            Button("Delete", role: .destructive) {
                guard let path = state.deleteConfirmPath else { return }
                let parentPath = parentDirectory(of: path)
                Task {
                    let success = await workspaceClient.deleteWorkspaceItem(path: path)
                    if success {
                        await state.refreshDirectory(parentPath, using: workspaceClient)
                        if state.selectedFilePath == path || state.selectedFilePath?.hasPrefix(path + "/") == true {
                            state.selectedFilePath = nil
                            state.selectedFileDetail = nil
                            state.editableContent = ""
                            state.originalContent = ""
                            state.isDirty = false
                        }
                        // Clean up stale expandedDirs and directoryCache for deleted path
                        state.expandedDirs.remove(path)
                        let deletedPrefix = path + "/"
                        state.expandedDirs = state.expandedDirs.filter { !$0.hasPrefix(deletedPrefix) }
                        state.directoryCache.removeValue(forKey: path)
                        for key in state.directoryCache.keys where key.hasPrefix(deletedPrefix) {
                            state.directoryCache.removeValue(forKey: key)
                        }
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This cannot be undone.")
        }
    }

    private func loadRoot() async {
        state.isLoadingTree = true
        if let response = await workspaceClient.fetchWorkspaceTree(path: "", showHidden: state.showHiddenFiles) {
            state.directoryCache[""] = response.entries

            // Auto-select IDENTITY.md if it exists and no file is already selected
            if state.selectedFilePath == nil,
               let identityEntry = response.entries.first(where: { $0.name == "IDENTITY.md" && !$0.isDirectory }) {
                await state.loadFile(path: identityEntry.path, using: workspaceClient)
            }
        }
        state.isLoadingTree = false
    }

    private func applyHiddenFilesToggle(_ newValue: Bool) {
        state.showHiddenFiles = newValue
        UserDefaults.standard.set(newValue, forKey: "showHiddenFiles")
        state.directoryCache.removeAll()
        state.expandedDirs.removeAll()
        state.selectedFilePath = nil
        state.selectedFileDetail = nil
        state.editableContent = ""
        state.originalContent = ""
        state.isDirty = false
        state.isLoadingTree = true
        state.hiddenFilesToggleRequestId &+= 1
        let requestId = state.hiddenFilesToggleRequestId
        Task {
            if let response = await workspaceClient.fetchWorkspaceTree(path: "", showHidden: newValue) {
                // Guard against stale response from a concurrent toggle (ABA pattern)
                guard state.hiddenFilesToggleRequestId == requestId else { return }
                state.directoryCache[""] = response.entries
            }
            // Only clear loading if this is still the latest request
            if state.hiddenFilesToggleRequestId == requestId {
                state.isLoadingTree = false
            }
        }
    }

    private func parentDirectory(of path: String) -> String {
        let components = path.split(separator: "/")
        guard components.count > 1 else { return "" }
        return components.dropLast().joined(separator: "/")
    }
}

// MARK: - Tree Sidebar

private struct WorkspaceTreeSidebar: View {
    @Bindable var state: WorkspaceBrowserState
    let workspaceClient: WorkspaceClient
    let onToggleHiddenFiles: (Bool) -> Void
    @State private var viewportWidth: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Files")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentDefault)

                Spacer()

                Button {
                    if state.isDirty {
                        state.pendingHiddenFilesToggle = !state.showHiddenFiles
                        state.showingDirtyAlert = true
                    } else {
                        onToggleHiddenFiles(!state.showHiddenFiles)
                    }
                } label: {
                    VIconView(state.showHiddenFiles ? .eye : .eyeOff, size: 12)
                        .foregroundStyle(state.showHiddenFiles ? VColor.contentDefault : VColor.contentSecondary)
                        .padding(4)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.sm)
                                .fill(state.showHiddenFiles ? VColor.surfaceActive : Color.clear)
                        )
                }
                .buttonStyle(.plain)
                .help(state.showHiddenFiles ? "Hide hidden files" : "Show hidden files")
                .accessibilityLabel(state.showHiddenFiles ? "Hide hidden files" : "Show hidden files")

                Menu {
                    Button {
                        state.newItemParentPath = ""
                        state.newItemName = ""
                        state.showingNewFileAlert = true
                    } label: {
                        Label { Text("New File") } icon: { VIconView(.filePlus, size: 12) }
                    }
                    Button {
                        state.newItemParentPath = ""
                        state.newItemName = ""
                        state.showingNewFolderAlert = true
                    } label: {
                        Label { Text("New Folder") } icon: { VIconView(.folder, size: 12) }
                    }
                } label: {
                    VIconView(.plus, size: 12)
                        .foregroundStyle(VColor.contentSecondary)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .accessibilityLabel("Add new file or folder")
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)

            Divider().background(VColor.borderBase)

            VStack(spacing: 0) {
                if state.isLoadingTree && state.directoryCache.isEmpty {
                    VStack {
                        Spacer()
                        ProgressView()
                            .frame(maxWidth: .infinity)
                        Spacer()
                    }
                } else {
                    ScrollView(.vertical) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            if let rootEntries = state.directoryCache[""] {
                                ForEach(rootEntries) { entry in
                                    WorkspaceTreeRow(
                                        entry: entry,
                                        depth: 0,
                                        state: state,
                                        workspaceClient: workspaceClient,
                                        minRowWidth: viewportWidth
                                    )
                                }
                            }
                        }
                        .padding(.vertical, VSpacing.xs)
                    }
                    .onGeometryChange(for: CGFloat.self) { proxy in
                        proxy.size.width
                    } action: { newWidth in
                        viewportWidth = newWidth
                    }
                }
            }
            .frame(maxHeight: .infinity, alignment: .topLeading)

            if state.uploadingCount > 0 {
                HStack(spacing: VSpacing.xs) {
                    ProgressView().controlSize(.small)
                    Text("Uploading \(state.uploadingCount) file\(state.uploadingCount == 1 ? "" : "s")...")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.xs)
            }
        }
        .overlay {
            if state.isDropTargeted {
                RoundedRectangle(cornerRadius: VRadius.md)
                    .strokeBorder(VColor.primaryBase, style: StrokeStyle(lineWidth: 2, dash: [6, 3]))
                    .padding(4)
            }
        }
        .onDrop(of: [.fileURL], isTargeted: $state.isDropTargeted) { providers in
            handleDrop(providers: providers, targetDir: "", state: state, workspaceClient: workspaceClient)
            return true
        }
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .strokeBorder(VColor.borderHover, lineWidth: 1)
                .allowsHitTesting(false)
        )
        .alert("New File", isPresented: $state.showingNewFileAlert) {
            TextField("Filename", text: $state.newItemName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let parentPath = state.newItemParentPath
                let name = state.newItemName
                guard !name.isEmpty else { return }
                let filePath = parentPath.isEmpty ? name : parentPath + "/" + name
                Task {
                    let success = await workspaceClient.writeWorkspaceFile(path: filePath, content: Data())
                    if success {
                        if let response = await workspaceClient.fetchWorkspaceTree(path: parentPath, showHidden: state.showHiddenFiles) {
                            state.directoryCache[parentPath] = response.entries
                        }
                        if !parentPath.isEmpty {
                            state.expandedDirs.insert(parentPath)
                        }
                    }
                }
            }
        }
        .alert("New Folder", isPresented: $state.showingNewFolderAlert) {
            TextField("Folder name", text: $state.newItemName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let parentPath = state.newItemParentPath
                let name = state.newItemName
                guard !name.isEmpty else { return }
                let folderPath = parentPath.isEmpty ? name : parentPath + "/" + name
                Task {
                    let success = await workspaceClient.createWorkspaceDirectory(path: folderPath)
                    if success {
                        if let response = await workspaceClient.fetchWorkspaceTree(path: parentPath, showHidden: state.showHiddenFiles) {
                            state.directoryCache[parentPath] = response.entries
                        }
                        if !parentPath.isEmpty {
                            state.expandedDirs.insert(parentPath)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Drop Handler

private func handleDrop(providers: [NSItemProvider], targetDir: String, state: WorkspaceBrowserState, workspaceClient: WorkspaceClient) {
    for provider in providers {
        provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
            guard let url = fileURLFromDropItem(item) else { return }
            let fileName = url.lastPathComponent
            let targetPath = targetDir.isEmpty ? fileName : "\(targetDir)/\(fileName)"
            Task {
                await MainActor.run { state.uploadingCount += 1 }
                if let fileData = try? Data(contentsOf: url) {
                    let success = await workspaceClient.writeWorkspaceFile(path: targetPath, content: fileData)
                    if success {
                        await state.refreshDirectory(targetDir, using: workspaceClient)
                    }
                }
                await MainActor.run { state.uploadingCount -= 1 }
            }
        }
    }
}

private func fileURLFromDropItem(_ item: NSSecureCoding?) -> URL? {
    if let data = item as? Data {
        return URL(dataRepresentation: data, relativeTo: nil)
    }
    if let url = item as? URL {
        return url
    }
    if let str = item as? String, let url = URL(string: str), url.isFileURL {
        return url
    }
    return nil
}

// MARK: - Tree Row

private struct WorkspaceTreeRow: View {
    let entry: WorkspaceTreeEntry
    let depth: Int
    @Bindable var state: WorkspaceBrowserState
    let workspaceClient: WorkspaceClient
    var minRowWidth: CGFloat = 0

    private var isExpanded: Bool {
        state.expandedDirs.contains(entry.path)
    }

    private var isSelected: Bool {
        state.selectedFilePath == entry.path
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                Task { await handleTap() }
            } label: {
                Group {
                    if state.renamingPath == entry.path {
                        // Rename mode: inline TextField (cannot use shared label)
                        HStack(spacing: VSpacing.xs) {
                            if entry.isDirectory {
                                VIconView(isExpanded ? .chevronDown : .chevronRight, size: 9)
                                    .foregroundStyle(VColor.contentTertiary)
                                    .frame(width: 12)
                            } else {
                                Spacer().frame(width: 12)
                            }
                            VIconView(entry.isDirectory ? .folder : .fileText, size: 12)
                                .foregroundStyle(entry.isDirectory ? VColor.primaryBase : VColor.contentSecondary)
                            TextField("Name", text: $state.renamingText)
                                .textFieldStyle(.plain)
                                .font(VFont.bodyMediumLighter)
                                .fixedSize(horizontal: true, vertical: false)
                                .onSubmit { submitRename() }
                                .onExitCommand { state.renamingPath = nil }
                        }
                        .padding(.leading, CGFloat(depth) * VSpacing.lg + VSpacing.sm)
                        .padding(.trailing, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .frame(minWidth: minRowWidth, alignment: .leading)
                        .background(isSelected ? VColor.surfaceActive : Color.clear)
                    } else {
                        // Normal mode: shared label
                        FileTreeRowLabel(
                            name: entry.name,
                            isDirectory: entry.isDirectory,
                            isExpanded: isExpanded,
                            depth: depth,
                            fileIcon: fileIcon(for: entry.mimeType ?? "application/octet-stream", fileName: entry.name),
                            minRowWidth: minRowWidth,
                            isDimmed: isHiddenPath(entry.path),
                            isActive: state.selectedFilePath == entry.path,
                            trailingText: entry.isDirectory ? nil : formattedFileSize(entry.size)
                        )
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onDrop(of: entry.isDirectory && !isHiddenPath(entry.path) ? [.fileURL] : [], isTargeted: .none) { providers in
                guard entry.isDirectory, !isHiddenPath(entry.path) else { return false }
                handleDrop(providers: providers, targetDir: entry.path, state: state, workspaceClient: workspaceClient)
                return true
            }

            // Expanded children
            if entry.isDirectory && isExpanded {
                if let children = state.directoryCache[entry.path] {
                    ForEach(children) { child in
                        WorkspaceTreeRow(
                            entry: child,
                            depth: depth + 1,
                            state: state,
                            workspaceClient: workspaceClient,
                            minRowWidth: minRowWidth
                        )
                    }
                }
            }
        }
        .contextMenu {
            let hidden = isHiddenPath(entry.path)
            if entry.isDirectory && !hidden {
                Button {
                    state.newItemParentPath = entry.path
                    state.newItemName = ""
                    state.showingNewFileAlert = true
                } label: {
                    Label { Text("New File") } icon: { VIconView(.filePlus, size: 12) }
                }
                Button {
                    state.newItemParentPath = entry.path
                    state.newItemName = ""
                    state.showingNewFolderAlert = true
                } label: {
                    Label { Text("New Folder") } icon: { VIconView(.folder, size: 12) }
                }
                Divider()
            }
            if !hidden {
                Button(role: .destructive) {
                    state.deleteConfirmPath = entry.path
                    state.deleteConfirmName = entry.name
                } label: {
                    Label { Text("Delete") } icon: { VIconView(.trash, size: 12) }
                }
                Button {
                    state.renamingPath = entry.path
                    state.renamingText = entry.name
                } label: {
                    Label { Text("Rename") } icon: { VIconView(.pencil, size: 12) }
                }
            }
        }
    }

    private func submitRename() {
        let oldPath = entry.path
        let parentPath = parentDirectory(of: oldPath)
        let newPath = parentPath.isEmpty ? state.renamingText : "\(parentPath)/\(state.renamingText)"
        Task {
            let success = await workspaceClient.renameWorkspaceItem(oldPath: oldPath, newPath: newPath)
            if success {
                if let response = await workspaceClient.fetchWorkspaceTree(path: parentPath, showHidden: state.showHiddenFiles) {
                    state.directoryCache[parentPath] = response.entries
                }

                // Update selectedFilePath and selectedFileDetail for exact match or descendants
                if state.selectedFilePath == oldPath {
                    state.selectedFilePath = newPath
                    if let detail = state.selectedFileDetail {
                        let newName = String(newPath.split(separator: "/").last ?? Substring(newPath))
                        state.selectedFileDetail = WorkspaceFileResponse(
                            path: newPath, name: newName, size: detail.size,
                            mimeType: detail.mimeType, modifiedAt: detail.modifiedAt,
                            content: detail.content, isBinary: detail.isBinary
                        )
                    }
                } else if let selected = state.selectedFilePath, selected.hasPrefix(oldPath + "/") {
                    let updatedPath = newPath + selected.dropFirst(oldPath.count)
                    state.selectedFilePath = updatedPath
                    if let detail = state.selectedFileDetail {
                        let newName = String(updatedPath.split(separator: "/").last ?? Substring(updatedPath))
                        state.selectedFileDetail = WorkspaceFileResponse(
                            path: updatedPath, name: newName, size: detail.size,
                            mimeType: detail.mimeType, modifiedAt: detail.modifiedAt,
                            content: detail.content, isBinary: detail.isBinary
                        )
                    }
                }

                // Migrate expandedDirs and directoryCache for renamed directories
                if entry.isDirectory {
                    let oldPrefix = oldPath + "/"
                    // Transfer expanded state
                    if state.expandedDirs.remove(oldPath) != nil {
                        state.expandedDirs.insert(newPath)
                    }
                    let descendantDirs = state.expandedDirs.filter { $0.hasPrefix(oldPrefix) }
                    for dir in descendantDirs {
                        state.expandedDirs.remove(dir)
                        state.expandedDirs.insert(newPath + dir.dropFirst(oldPath.count))
                    }
                    // Invalidate directory cache for renamed directory and descendants
                    // (WorkspaceTreeEntry.path is immutable, so entries must be re-fetched)
                    let cacheKeys = state.directoryCache.keys.filter { $0 == oldPath || $0.hasPrefix(oldPrefix) }
                    for key in cacheKeys {
                        state.directoryCache.removeValue(forKey: key)
                    }
                    // Re-fetch contents for directories that remain expanded under the new path
                    let newExpandedDirs = state.expandedDirs.filter { $0 == newPath || $0.hasPrefix(newPath + "/") }
                    for dir in newExpandedDirs {
                        if let response = await workspaceClient.fetchWorkspaceTree(path: dir, showHidden: state.showHiddenFiles) {
                            state.directoryCache[dir] = response.entries
                        }
                    }
                }
            }
            state.renamingPath = nil
        }
    }

    private func parentDirectory(of path: String) -> String {
        let components = path.split(separator: "/")
        guard components.count > 1 else { return "" }
        return components.dropLast().joined(separator: "/")
    }

    private func handleTap() async {
        if entry.isDirectory {
            if isExpanded {
                state.expandedDirs.remove(entry.path)
            } else {
                state.expandedDirs.insert(entry.path)
                // Load children if not cached
                if state.directoryCache[entry.path] == nil {
                    if let response = await workspaceClient.fetchWorkspaceTree(path: entry.path, showHidden: state.showHiddenFiles) {
                        state.directoryCache[entry.path] = response.entries
                    }
                }
            }
        } else {
            let targetPath = entry.path
            // Skip if already selected
            guard targetPath != state.selectedFilePath else { return }
            // If there are unsaved changes, confirm before switching
            if state.isDirty {
                state.pendingSwitchPath = targetPath
                state.showingDirtyAlert = true
            } else {
                await state.loadFile(path: targetPath, using: workspaceClient)
            }
        }
    }
}

// MARK: - File Viewer

private struct WorkspaceFileViewer: View {
    @Bindable var state: WorkspaceBrowserState
    let workspaceClient: WorkspaceClient

    var body: some View {
        Group {
            if state.isLoadingFile {
                VStack {
                    Spacer()
                    ProgressView("Loading file...")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentTertiary)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let detail = state.selectedFileDetail {
                fileContent(detail)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .fill(VColor.surfaceBase)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .strokeBorder(VColor.borderBase, lineWidth: 1)
                    )
                    .padding(.horizontal, VSpacing.md)
            } else {
                emptyState
            }
        }
    }

    private var emptyState: some View {
        VEmptyState(title: "Select a file to view", icon: VIcon.fileText.rawValue)
    }

    @ViewBuilder
    private func fileContent(_ detail: WorkspaceFileResponse) -> some View {
        let mime = detail.mimeType.lowercased()
        let isText = !detail.isBinary && detail.content != nil
        let readOnly = isText && isHiddenPath(detail.path)

        VStack(spacing: 0) {
            if isText {
                FileContentView(
                    fileName: detail.name,
                    mimeType: detail.mimeType,
                    content: $state.editableContent,
                    viewMode: $state.viewMode,
                    isEditable: !readOnly,
                    showReadOnlyBadge: readOnly,
                    onTextChange: { newValue in
                        state.isDirty = newValue != state.originalContent
                    },
                    isActivelyEditing: $state.isActivelyEditing,
                    fileIdentity: detail.path
                )
            } else {
                FileContentHeaderBar(
                    icon: fileIcon(for: mime, fileName: detail.name),
                    fileName: detail.name
                )
                Divider().background(VColor.borderBase)

                if mime.hasPrefix("image/") {
                    imageViewer(detail)
                } else if mime.hasPrefix("video/") {
                    videoViewer(detail)
                } else if !detail.isBinary, detail.content == nil {
                    fileTooLarge(detail)
                } else {
                    binaryFallback(detail)
                }
            }

            if isText && !readOnly && state.isActivelyEditing {
                editFooter(filePath: detail.path)
            }
        }
    }

    /// Save/Discard footer shown at the bottom of the file viewer during editing.
    private func editFooter(filePath: String) -> some View {
        VStack(spacing: 0) {
            Divider().background(VColor.borderBase)
            HStack {
                Spacer()
                HStack(spacing: VSpacing.xs) {
                    VButton(
                        label: "Discard",
                        style: .ghost,
                        size: .compact,
                        isDisabled: state.isSaving
                    ) {
                        state.editableContent = state.originalContent
                        state.isDirty = false
                        state.isActivelyEditing = false
                    }
                    if state.isSaving {
                        VBusyIndicator(size: 8)
                    }
                    VButton(
                        label: "Save",
                        style: .primary,
                        size: .compact,
                        isDisabled: state.isSaving || !state.isDirty
                    ) {
                        Task {
                            await saveFile(path: filePath)
                            if !state.isDirty {
                                state.isActivelyEditing = false
                            }
                        }
                    }
                    .keyboardShortcut("s", modifiers: .command)
                }
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(VColor.surfaceOverlay)
        }
    }

    private func saveFile(path: String) async {
        state.isSaving = true
        let snapshot = state.editableContent
        let data = Data(snapshot.utf8)
        let success = await workspaceClient.writeWorkspaceFile(path: path, content: data)
        // Only update editor state if the user is still viewing the file that was saved
        guard state.selectedFilePath == path else {
            state.isSaving = false
            return
        }
        if success {
            state.originalContent = snapshot
            state.isDirty = state.editableContent != snapshot
        }
        state.isSaving = false
    }

    private func fileTooLarge(_ detail: WorkspaceFileResponse) -> some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            VIconView(.fileText, size: 40)
                .foregroundStyle(VColor.contentTertiary)

            Text("File too large to preview")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func imageViewer(_ detail: WorkspaceFileResponse) -> some View {
        AuthenticatedImageView(filePath: detail.path, showHidden: state.showHiddenFiles, workspaceClient: workspaceClient)
    }

    private func videoViewer(_ detail: WorkspaceFileResponse) -> some View {
        WorkspaceVideoPlayer(filePath: detail.path, showHidden: state.showHiddenFiles, workspaceClient: workspaceClient)
    }

    private func binaryFallback(_ detail: WorkspaceFileResponse) -> some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            VIconView(.file, size: 40)
                .foregroundStyle(VColor.contentTertiary)

            VStack(spacing: VSpacing.sm) {
                Text(detail.mimeType)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)

                Text("Modified: \(detail.modifiedAt)")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

}

// MARK: - File Size Formatter

/// Formats an optional byte count into a human-readable size string.
private func formattedFileSize(_ bytes: Int?) -> String? {
    guard let bytes else { return nil }
    if bytes < 1024 {
        return "\(bytes) bytes"
    } else if bytes < 1024 * 1024 {
        return "\(bytes / 1024) KB"
    } else {
        return "\(String(format: "%.1f", Double(bytes) / (1024 * 1024))) MB"
    }
}

// MARK: - Hidden Path Helper

/// Returns true if any segment of the path starts with a dot (e.g. ".hidden/file.txt" or "dir/.env").
private func isHiddenPath(_ path: String) -> Bool {
    path.split(separator: "/").contains { $0.hasPrefix(".") }
}

// MARK: - Authenticated Image View

private struct AuthenticatedImageView: View {
    let filePath: String
    let showHidden: Bool
    let workspaceClient: WorkspaceClient
    @State private var image: NSImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(VSpacing.md)
            } else if failed {
                VStack {
                    VIconView(.triangleAlert, size: 24)
                        .foregroundStyle(VColor.systemNegativeHover)
                    Text("Failed to load image")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: filePath) {
            image = nil
            failed = false
            do {
                let data = try await workspaceClient.fetchWorkspaceFileContent(path: filePath, showHidden: showHidden)
                image = NSImage(data: data)
                if image == nil { failed = true }
            } catch {
                if !Task.isCancelled {
                    failed = true
                }
            }
        }
    }
}

// MARK: - Video Player

private struct WorkspaceVideoPlayer: View {
    let filePath: String
    let showHidden: Bool
    let workspaceClient: WorkspaceClient
    @State private var player: AVPlayer?
    @State private var tempFileURL: URL?
    @State private var failed = false

    var body: some View {
        Group {
            if let player {
                VideoPlayer(player: player)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(VSpacing.md)
            } else if failed {
                VStack {
                    VIconView(.triangleAlert, size: 24)
                        .foregroundStyle(VColor.systemNegativeHover)
                    Text("Failed to load video")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: filePath) {
            player?.pause()
            player = nil
            failed = false
            cleanupTempFile()
            await loadVideo()
        }
        .onDisappear {
            player?.pause()
            player = nil
            cleanupTempFile()
        }
    }

    private func loadVideo() async {
        do {
            let localURL = try await workspaceClient.downloadWorkspaceFileContent(path: filePath, showHidden: showHidden)
            guard !Task.isCancelled else {
                try? FileManager.default.removeItem(at: localURL)
                return
            }
            tempFileURL = localURL
            player = AVPlayer(url: localURL)
        } catch {
            if !Task.isCancelled {
                failed = true
            }
        }
    }

    private func cleanupTempFile() {
        if let tempFileURL {
            try? FileManager.default.removeItem(at: tempFileURL)
        }
        tempFileURL = nil
    }
}
