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
    var showHiddenFiles: Bool = UserDefaults.standard.bool(forKey: "showHiddenFiles")
    var hiddenFilesToggleRequestId: UInt64 = 0

    func refreshDirectory(_ dirPath: String, using workspaceClient: any WorkspaceClientProtocol) async {
        if let response = await workspaceClient.fetchWorkspaceTree(path: dirPath, showHidden: showHiddenFiles) {
            directoryCache[dirPath] = response.entries
        }
    }

    func loadFile(path targetPath: String, using daemonClient: DaemonClient) async {
        selectedFilePath = targetPath
        viewMode = .source
        isLoadingFile = true
        selectedFileDetail = nil
        isDirty = false
        editableContent = ""
        fileLoadTask?.cancel()
        let task = Task {
            let detail = await daemonClient.fetchWorkspaceFile(path: targetPath, showHidden: showHiddenFiles)
            guard !Task.isCancelled, selectedFilePath == targetPath else { return }
            selectedFileDetail = detail
            editableContent = detail?.content ?? ""
            originalContent = detail?.content ?? ""
            isDirty = false
            isSaving = false
            isLoadingFile = false

            // Default read-only markdown files to preview mode
            let ext = (targetPath as NSString).pathExtension.lowercased()
            if (ext == "md" || ext == "markdown") && isHiddenPath(targetPath) {
                viewMode = .preview
            }
        }
        fileLoadTask = task
    }
}

// MARK: - Workspace Panel

struct WorkspacePanel: View {
    let daemonClient: DaemonClient
    @State private var state = WorkspaceBrowserState()
    private let workspaceClient = WorkspaceClient()
    @State private var sidebarWidth: CGFloat = 300
    @State private var dragStartWidth: CGFloat?
    @State private var didPushResizeCursor = false

    private let minSidebarWidth: CGFloat = 140
    private let maxSidebarWidth: CGFloat = 500

    private let dragCoordinateSpace = "WorkspacePanelDrag"

    var body: some View {
        HStack(spacing: 0) {
            WorkspaceTreeSidebar(state: state, daemonClient: daemonClient, workspaceClient: workspaceClient, onToggleHiddenFiles: applyHiddenFilesToggle)
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

            WorkspaceFileViewer(state: state, daemonClient: daemonClient)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .coordinateSpace(name: dragCoordinateSpace)
        .task { await loadRoot() }
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
                    Task { await state.loadFile(path: targetPath, using: daemonClient) }
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
                    let success = await daemonClient.deleteWorkspaceItem(path: path)
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
                await state.loadFile(path: identityEntry.path, using: daemonClient)
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
    let daemonClient: DaemonClient
    let workspaceClient: WorkspaceClient
    let onToggleHiddenFiles: (Bool) -> Void
    @State private var viewportWidth: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Files")
                    .font(VFont.headline)
                    .foregroundColor(VColor.contentDefault)

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
                        .foregroundColor(state.showHiddenFiles ? VColor.contentDefault : VColor.contentSecondary)
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
                        .foregroundColor(VColor.contentSecondary)
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
                                        daemonClient: daemonClient,
                                        workspaceClient: workspaceClient,
                                        minRowWidth: viewportWidth
                                    )
                                }
                            }
                        }
                        .padding(.vertical, VSpacing.xs)
                    }
                    .background {
                        GeometryReader { geo in
                            Color.clear
                                .onAppear { viewportWidth = geo.size.width }
                                .onChange(of: geo.size.width) { _, newWidth in
                                    viewportWidth = newWidth
                                }
                        }
                    }
                }
            }
            .frame(maxHeight: .infinity, alignment: .topLeading)

            if state.uploadingCount > 0 {
                HStack(spacing: VSpacing.xs) {
                    ProgressView().controlSize(.small)
                    Text("Uploading \(state.uploadingCount) file\(state.uploadingCount == 1 ? "" : "s")...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
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
            handleDrop(providers: providers, targetDir: "", state: state, daemonClient: daemonClient, workspaceClient: workspaceClient)
            return true
        }
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .alert("New File", isPresented: $state.showingNewFileAlert) {
            TextField("Filename", text: $state.newItemName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let parentPath = state.newItemParentPath
                let name = state.newItemName
                guard !name.isEmpty else { return }
                let filePath = parentPath.isEmpty ? name : parentPath + "/" + name
                Task {
                    let success = await daemonClient.writeWorkspaceFile(path: filePath, content: Data())
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
                    let success = await daemonClient.createWorkspaceDirectory(path: folderPath)
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

private func handleDrop(providers: [NSItemProvider], targetDir: String, state: WorkspaceBrowserState, daemonClient: DaemonClient, workspaceClient: WorkspaceClient) {
    for provider in providers {
        provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
            guard let url = fileURLFromDropItem(item) else { return }
            let fileName = url.lastPathComponent
            let targetPath = targetDir.isEmpty ? fileName : "\(targetDir)/\(fileName)"
            Task {
                await MainActor.run { state.uploadingCount += 1 }
                if let fileData = try? Data(contentsOf: url) {
                    let success = await daemonClient.writeWorkspaceFile(path: targetPath, content: fileData)
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
    let daemonClient: DaemonClient
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
                                    .foregroundColor(VColor.contentTertiary)
                                    .frame(width: 12)
                            } else {
                                Spacer().frame(width: 12)
                            }
                            VIconView(entry.isDirectory ? .folder : .fileText, size: 12)
                                .foregroundColor(entry.isDirectory ? VColor.primaryBase : VColor.contentSecondary)
                            TextField("Name", text: $state.renamingText)
                                .textFieldStyle(.plain)
                                .font(VFont.body)
                                .fixedSize(horizontal: true, vertical: false)
                                .onSubmit { submitRename() }
                                .onExitCommand { state.renamingPath = nil }
                        }
                        .padding(.leading, CGFloat(depth) * VSpacing.lg + VSpacing.sm)
                        .padding(.trailing, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .frame(minWidth: minRowWidth, alignment: .leading)
                    } else {
                        // Normal mode: shared label
                        FileTreeRowLabel(
                            name: entry.name,
                            isDirectory: entry.isDirectory,
                            isExpanded: isExpanded,
                            depth: depth,
                            fileIcon: .fileText,
                            minRowWidth: minRowWidth
                        )
                    }
                }
                .contentShape(Rectangle())
                .background(isSelected ? VColor.surfaceActive : Color.clear)
            }
            .buttonStyle(.plain)
            .onDrop(of: entry.isDirectory && !isHiddenPath(entry.path) ? [.fileURL] : [], isTargeted: .none) { providers in
                guard entry.isDirectory, !isHiddenPath(entry.path) else { return false }
                handleDrop(providers: providers, targetDir: entry.path, state: state, daemonClient: daemonClient, workspaceClient: workspaceClient)
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
                            daemonClient: daemonClient,
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
            let success = await daemonClient.renameWorkspaceItem(oldPath: oldPath, newPath: newPath)
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
                await state.loadFile(path: targetPath, using: daemonClient)
            }
        }
    }
}

// MARK: - File Viewer

private struct WorkspaceFileViewer: View {
    @Bindable var state: WorkspaceBrowserState
    let daemonClient: DaemonClient

    var body: some View {
        Group {
            if state.isLoadingFile {
                VStack {
                    Spacer()
                    ProgressView("Loading file...")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentTertiary)
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
        .background(VColor.surfaceOverlay)
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
            FileContentHeaderBar(
                icon: fileIcon(for: mime),
                fileName: detail.name,
                fileSize: formatFileSize(detail.size)
            ) {
                if isText {
                    let modes = availableViewModes(for: detail.name, mimeType: detail.mimeType)
                    if modes.count > 1 {
                        VSegmentedControl(
                            items: modes.map { (label: viewModeLabel($0), tag: $0) },
                            selection: $state.viewMode,
                            style: .pill
                        )
                        .frame(width: CGFloat(modes.count) * 80)
                    }
                }

                if isText && readOnly {
                    Text("Read-only")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                } else if isText && state.isDirty {
                    HStack(spacing: VSpacing.xs) {
                        if state.isSaving {
                            VBusyIndicator(size: 8)
                        }
                        VButton(
                            label: "Save",
                            style: .primary,
                            size: .compact,
                            isDisabled: state.isSaving
                        ) {
                            Task { await saveFile(path: detail.path) }
                        }
                        .keyboardShortcut("s", modifiers: .command)
                    }
                }
            }
            Divider().background(VColor.borderBase)

            if isText {
                textViewer(detail, readOnly: readOnly)
            } else if mime.hasPrefix("image/") {
                imageViewer(detail)
            } else if mime.hasPrefix("video/") {
                videoViewer(detail)
            } else if !detail.isBinary, detail.content == nil {
                fileTooLarge(detail)
            } else {
                binaryFallback(detail)
            }
        }
    }

    private func fileIcon(for mimeType: String) -> VIcon {
        if mimeType.hasPrefix("image/") { return .image }
        if mimeType.hasPrefix("video/") { return .video }
        if mimeType.hasPrefix("text/") { return .fileText }
        if mimeType == "application/json" || mimeType == "application/javascript" || mimeType == "application/typescript" { return .fileCode }
        return .file
    }

    @ViewBuilder
    private func textViewer(_ detail: WorkspaceFileResponse, readOnly: Bool) -> some View {
        let modes = availableViewModes(for: detail.name, mimeType: detail.mimeType)
        let effectiveMode = modes.contains(state.viewMode) ? state.viewMode : (modes.first ?? .source)

        switch effectiveMode {
        case .source:
            sourceView(detail)
        case .preview:
            previewView(detail)
        case .tree:
            treeView(detail)
        }
    }

    private func sourceView(_ detail: WorkspaceFileResponse) -> some View {
        let readOnly = isHiddenPath(detail.path)
        let language = SyntaxLanguage.detect(fileName: detail.name, mimeType: detail.mimeType)
        return Group {
            if readOnly {
                HighlightedTextView(
                    text: .constant(detail.content ?? ""),
                    language: language,
                    isEditable: false
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                HighlightedTextView(
                    text: $state.editableContent,
                    language: language,
                    isEditable: true,
                    onTextChange: { newValue in
                        state.isDirty = newValue != state.originalContent
                    }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func previewView(_ detail: WorkspaceFileResponse) -> some View {
        MarkdownPreviewView(content: state.editableContent)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func treeView(_ detail: WorkspaceFileResponse) -> some View {
        JSONTreeView(content: state.editableContent)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func saveFile(path: String) async {
        state.isSaving = true
        let snapshot = state.editableContent
        let data = Data(snapshot.utf8)
        let success = await daemonClient.writeWorkspaceFile(path: path, content: data)
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
                .foregroundColor(VColor.contentTertiary)

            Text("File too large to preview")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func imageViewer(_ detail: WorkspaceFileResponse) -> some View {
        Group {
            if let url = daemonClient.workspaceFileContentURL(path: detail.path, showHidden: state.showHiddenFiles) {
                AuthenticatedImageView(url: url, daemonClient: daemonClient)
            } else {
                Text("Unable to load image URL")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentTertiary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func videoViewer(_ detail: WorkspaceFileResponse) -> some View {
        Group {
            if let url = daemonClient.workspaceFileContentURL(path: detail.path, showHidden: state.showHiddenFiles) {
                WorkspaceVideoPlayer(url: url, daemonClient: daemonClient)
            } else {
                Text("Unable to load video URL")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentTertiary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func binaryFallback(_ detail: WorkspaceFileResponse) -> some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            VIconView(.file, size: 40)
                .foregroundColor(VColor.contentTertiary)

            VStack(spacing: VSpacing.sm) {
                Text(detail.mimeType)
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)

                Text("Modified: \(detail.modifiedAt)")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

}

// MARK: - Hidden Path Helper

/// Returns true if any segment of the path starts with a dot (e.g. ".hidden/file.txt" or "dir/.env").
private func isHiddenPath(_ path: String) -> Bool {
    path.split(separator: "/").contains { $0.hasPrefix(".") }
}

// MARK: - Authenticated Image View

private struct AuthenticatedImageView: View {
    let url: URL
    let daemonClient: DaemonClient
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
                        .foregroundColor(VColor.systemNegativeHover)
                    Text("Failed to load image")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentTertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: url) {
            image = nil
            failed = false
            do {
                let loadedImage = try await fetchImage(url: url)
                image = loadedImage
                if image == nil { failed = true }
            } catch {
                if !Task.isCancelled {
                    failed = true
                }
            }
        }
    }

    private func fetchImage(url: URL) async throws -> NSImage? {
        var request = URLRequest(url: url)
        if let token = ActorTokenManager.getToken(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            return nil
        }
        // On 401, re-bootstrap actor token via daemon and retry once
        if http.statusCode == 401 {
            guard let platform = daemonClient.recoveryPlatform,
                  let deviceId = daemonClient.recoveryDeviceId else {
                return nil
            }
            let success = await daemonClient.bootstrapActorToken(platform: platform, deviceId: deviceId)
            guard success else { return nil }
            var retryRequest = URLRequest(url: url)
            if let freshToken = ActorTokenManager.getToken(), !freshToken.isEmpty {
                retryRequest.setValue("Bearer \(freshToken)", forHTTPHeaderField: "Authorization")
            }
            let (retryData, retryResponse) = try await URLSession.shared.data(for: retryRequest)
            guard let retryHttp = retryResponse as? HTTPURLResponse, (200...299).contains(retryHttp.statusCode) else {
                return nil
            }
            return NSImage(data: retryData)
        }
        guard (200...299).contains(http.statusCode) else {
            return nil
        }
        return NSImage(data: data)
    }
}

// MARK: - Video Player

private struct WorkspaceVideoPlayer: View {
    let url: URL
    let daemonClient: DaemonClient
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
                        .foregroundColor(VColor.systemNegativeHover)
                    Text("Failed to load video")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentTertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: url) {
            player?.pause()
            player = nil
            failed = false
            if let tempFileURL {
                try? FileManager.default.removeItem(at: tempFileURL)
            }
            tempFileURL = nil
            await loadVideo()
        }
        .onDisappear {
            player?.pause()
            player = nil
            if let tempFileURL {
                try? FileManager.default.removeItem(at: tempFileURL)
            }
        }
    }

    private func loadVideo() async {
        do {
            let result = try await downloadVideo(url: url)
            guard !Task.isCancelled else {
                // Clean up downloaded file if task was cancelled during download
                if let localURL = result {
                    try? FileManager.default.removeItem(at: localURL)
                }
                return
            }
            guard let localURL = result else {
                failed = true
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

    /// Downloads video to a temp file using streaming (avoids buffering entire file in memory).
    /// Returns the local file URL on success, nil on non-success HTTP status.
    /// On 401, re-bootstraps actor token via daemon and retries once.
    private func downloadVideo(url: URL) async throws -> URL? {
        var request = URLRequest(url: url)
        if let token = ActorTokenManager.getToken(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (downloadedURL, response) = try await URLSession.shared.download(for: request)
        guard let http = response as? HTTPURLResponse else {
            return nil
        }
        // On 401, re-bootstrap actor token via daemon and retry once
        if http.statusCode == 401 {
            try? FileManager.default.removeItem(at: downloadedURL)
            guard let platform = daemonClient.recoveryPlatform,
                  let deviceId = daemonClient.recoveryDeviceId else {
                return nil
            }
            let success = await daemonClient.bootstrapActorToken(platform: platform, deviceId: deviceId)
            guard success else { return nil }
            var retryRequest = URLRequest(url: url)
            if let freshToken = ActorTokenManager.getToken(), !freshToken.isEmpty {
                retryRequest.setValue("Bearer \(freshToken)", forHTTPHeaderField: "Authorization")
            }
            let (retryURL, retryResponse) = try await URLSession.shared.download(for: retryRequest)
            guard let retryHttp = retryResponse as? HTTPURLResponse, (200...299).contains(retryHttp.statusCode) else {
                try? FileManager.default.removeItem(at: retryURL)
                return nil
            }
            let dest = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
            try FileManager.default.moveItem(at: retryURL, to: dest)
            return dest
        }
        guard (200...299).contains(http.statusCode) else {
            try? FileManager.default.removeItem(at: downloadedURL)
            return nil
        }
        let dest = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
        try FileManager.default.moveItem(at: downloadedURL, to: dest)
        return dest
    }
}
