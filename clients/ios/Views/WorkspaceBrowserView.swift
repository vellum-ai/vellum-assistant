#if canImport(UIKit)
import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

struct WorkspaceBrowserView: View {
    let client: DaemonClient?
    var initialPath: String = ""
    private let workspaceClient = WorkspaceClient()

    @State private var entries: [WorkspaceTreeEntry] = []
    @State private var isLoading = true
    @State private var selectedFile: WorkspaceTreeEntry?
    @State private var showingNewFileAlert = false
    @State private var showingNewFolderAlert = false
    @State private var newItemName: String = ""
    @State private var newItemParentPath: String = ""
    @State private var deletingEntry: WorkspaceTreeEntry?
    @State private var renamingEntry: WorkspaceTreeEntry?
    @State private var renameText: String = ""
    @State private var showDocumentPicker = false

    var body: some View {
        Group {
            if isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if entries.isEmpty {
                VStack(spacing: VSpacing.md) {
                    VIconView(.folder, size: 36)
                        .foregroundColor(VColor.contentTertiary)
                        .accessibilityHidden(true)
                    Text("Empty directory")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                entryList
            }
        }
        .navigationTitle(initialPath.isEmpty ? "Workspace" : lastPathComponent(initialPath))
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                HStack(spacing: VSpacing.md) {
                    Button { showDocumentPicker = true } label: {
                        VIconView(.upload, size: 16)
                            .accessibilityLabel("Import files")
                    }

                    Menu {
                        Button {
                            newItemName = ""
                            newItemParentPath = ""
                            showingNewFileAlert = true
                        } label: {
                            Label { Text("New File") } icon: { VIconView(.filePlus, size: 14) }
                        }
                        Button {
                            newItemName = ""
                            newItemParentPath = ""
                            showingNewFolderAlert = true
                        } label: {
                            Label { Text("New Folder") } icon: { VIconView(.folder, size: 14) }
                        }
                    } label: {
                        VIconView(.plus, size: 16)
                            .accessibilityLabel("Add item")
                    }
                }
            }
        }
        .fileImporter(
            isPresented: $showDocumentPicker,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            handleFileImport(result)
        }
        .sheet(item: $selectedFile) { file in
            WorkspaceFileSheet(filePath: file.path, mimeType: file.mimeType, client: client)
        }
        .task { await loadDirectory() }
        .alert("New File", isPresented: $showingNewFileAlert) {
            newFileAlertContent
        }
        .alert("New Folder", isPresented: $showingNewFolderAlert) {
            newFolderAlertContent
        }
        .alert("Rename", isPresented: renameAlertBinding) {
            renameAlertContent
        }
        .alert("Delete", isPresented: deleteAlertBinding) {
            deleteAlertContent
        } message: {
            Text("Delete \"\(deletingEntry?.name ?? "")\"? This cannot be undone.")
        }
    }

    // MARK: - Entry List

    private var entryList: some View {
        List {
            ForEach(entries) { entry in
                entryRow(entry)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            deletingEntry = entry
                        } label: {
                            Label { Text("Delete") } icon: { VIconView(.trash, size: 14) }
                        }
                    }
                    .swipeActions(edge: .leading) {
                        Button {
                            renamingEntry = entry
                            renameText = entry.name
                        } label: {
                            Label { Text("Rename") } icon: { VIconView(.pencil, size: 14) }
                        }
                        .tint(.blue)
                    }
                    .contextMenu {
                        entryContextMenu(entry)
                    }
            }
        }
        .listStyle(.plain)
    }

    @ViewBuilder
    private func entryRow(_ entry: WorkspaceTreeEntry) -> some View {
        if entry.isDirectory {
            NavigationLink(destination: WorkspaceBrowserView(client: client, initialPath: entry.path)) {
                directoryRow(entry)
            }
        } else {
            Button { selectedFile = entry } label: {
                fileRow(entry)
            }
        }
    }

    // MARK: - Context Menu

    @ViewBuilder
    private func entryContextMenu(_ entry: WorkspaceTreeEntry) -> some View {
        Button {
            renamingEntry = entry
            renameText = entry.name
        } label: {
            Label { Text("Rename") } icon: { VIconView(.pencil, size: 14) }
        }

        Button(role: .destructive) {
            deletingEntry = entry
        } label: {
            Label { Text("Delete") } icon: { VIconView(.trash, size: 14) }
        }

        if entry.isDirectory {
            Divider()

            Button {
                newItemName = ""
                newItemParentPath = entry.path
                showingNewFileAlert = true
            } label: {
                Label { Text("New File") } icon: { VIconView(.filePlus, size: 14) }
            }

            Button {
                newItemName = ""
                newItemParentPath = entry.path
                showingNewFolderAlert = true
            } label: {
                Label { Text("New Folder") } icon: { VIconView(.folder, size: 14) }
            }
        }
    }

    // MARK: - Alert Bindings

    private var renameAlertBinding: Binding<Bool> {
        Binding(
            get: { renamingEntry != nil },
            set: { if !$0 { renamingEntry = nil } }
        )
    }

    private var deleteAlertBinding: Binding<Bool> {
        Binding(
            get: { deletingEntry != nil },
            set: { if !$0 { deletingEntry = nil } }
        )
    }

    // MARK: - Alert Content

    @ViewBuilder
    private var newFileAlertContent: some View {
        TextField("Filename", text: $newItemName)
        Button("Create") {
            let path = buildPath(newItemName)
            Task {
                if let client, await client.writeWorkspaceFile(path: path, content: Data()) {
                    await reloadDirectory()
                }
            }
        }
        Button("Cancel", role: .cancel) {}
    }

    @ViewBuilder
    private var newFolderAlertContent: some View {
        TextField("Folder name", text: $newItemName)
        Button("Create") {
            let path = buildPath(newItemName)
            Task {
                if let client, await client.createWorkspaceDirectory(path: path) {
                    await reloadDirectory()
                }
            }
        }
        Button("Cancel", role: .cancel) {}
    }

    @ViewBuilder
    private var renameAlertContent: some View {
        TextField("New name", text: $renameText)
        Button("Rename") {
            guard let entry = renamingEntry else { return }
            let oldPath = entry.path
            let parentPath = oldPath.contains("/")
                ? String(oldPath[...oldPath.lastIndex(of: "/")!])
                : ""
            let newPath = parentPath + renameText
            Task {
                if let client, await client.renameWorkspaceItem(oldPath: oldPath, newPath: newPath) {
                    await reloadDirectory()
                }
            }
            renamingEntry = nil
        }
        Button("Cancel", role: .cancel) {
            renamingEntry = nil
        }
    }

    @ViewBuilder
    private var deleteAlertContent: some View {
        Button("Delete", role: .destructive) {
            guard let entry = deletingEntry else { return }
            Task {
                if let client, await client.deleteWorkspaceItem(path: entry.path) {
                    await reloadDirectory()
                }
            }
            deletingEntry = nil
        }
        Button("Cancel", role: .cancel) {
            deletingEntry = nil
        }
    }

    // MARK: - Row Views

    private func directoryRow(_ entry: WorkspaceTreeEntry) -> some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.folder, size: 16)
                .foregroundColor(VColor.primaryBase)
                .frame(width: 24)
                .accessibilityHidden(true)

            Text(entry.name)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)

            Spacer()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(entry.name), directory")
    }

    private func fileRow(_ entry: WorkspaceTreeEntry) -> some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(iconForMimeType(entry.mimeType), size: 16)
                .foregroundColor(VColor.primaryBase)
                .frame(width: 24)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)

                if let size = entry.size {
                    Text(formatFileSize(size))
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
            }

            Spacer()

            VIconView(.chevronRight, size: 12)
                .foregroundColor(VColor.contentTertiary)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(entry.name)
        .accessibilityHint("Opens file viewer")
    }

    // MARK: - File Import

    private func handleFileImport(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result else { return }
        for url in urls {
            let didAccess = url.startAccessingSecurityScopedResource()
            defer { if didAccess { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { continue }
            let fileName = url.lastPathComponent
            let targetPath = initialPath.isEmpty ? fileName : "\(initialPath)/\(fileName)"
            Task {
                let success = await client?.writeWorkspaceFile(path: targetPath, content: data) ?? false
                if success { await reloadDirectory() }
            }
        }
    }

    // MARK: - Helpers

    private func loadDirectory() async {
        guard let client else {
            isLoading = false
            return
        }

        if let response = await workspaceClient.fetchWorkspaceTree(path: initialPath, showHidden: false) {
            entries = response.entries
        }
        isLoading = false
    }

    private func reloadDirectory() async {
        if let response = await workspaceClient.fetchWorkspaceTree(path: initialPath, showHidden: false) {
            entries = response.entries
        }
    }

    private func buildPath(_ name: String) -> String {
        let parent = newItemParentPath.isEmpty ? initialPath : newItemParentPath
        if parent.isEmpty {
            return name
        }
        let base = parent.hasSuffix("/") ? parent : parent + "/"
        return base + name
    }

    private func lastPathComponent(_ path: String) -> String {
        let trimmed = path.hasSuffix("/") ? String(path.dropLast()) : path
        return trimmed.components(separatedBy: "/").last ?? path
    }

    private func iconForMimeType(_ mimeType: String?) -> VIcon {
        guard let mimeType else { return .file }
        if mimeType.hasPrefix("image/") { return .image }
        if mimeType.hasPrefix("video/") { return .video }
        if mimeType.hasPrefix("text/") { return .fileText }
        if mimeType == "application/json" { return .fileCode }
        if mimeType == "application/pdf" { return .fileText }
        return .file
    }
}
#endif
