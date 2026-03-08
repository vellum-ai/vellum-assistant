import SwiftUI
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
    var error: String?
}

// MARK: - Workspace Panel

struct WorkspacePanel: View {
    let daemonClient: DaemonClient
    @State private var state = WorkspaceBrowserState()

    var body: some View {
        HSplitView {
            WorkspaceTreeSidebar(state: state, daemonClient: daemonClient)
                .frame(minWidth: 200, idealWidth: 250, maxWidth: 300)
            WorkspaceFileViewer(state: state, daemonClient: daemonClient)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .task { await loadRoot() }
    }

    private func loadRoot() async {
        state.isLoadingTree = true
        if let response = await daemonClient.fetchWorkspaceTree(path: "") {
            state.directoryCache[""] = response.entries
        }
        state.isLoadingTree = false
    }
}

// MARK: - Tree Sidebar

private struct WorkspaceTreeSidebar: View {
    @Bindable var state: WorkspaceBrowserState
    let daemonClient: DaemonClient

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Files")
                .font(VFont.headline)
                .foregroundColor(VColor.textPrimary)
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)

            Divider().background(VColor.surfaceBorder)

            if state.isLoadingTree && state.directoryCache.isEmpty {
                VStack {
                    Spacer()
                    ProgressView()
                        .frame(maxWidth: .infinity)
                    Spacer()
                }
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if let rootEntries = state.directoryCache[""] {
                            ForEach(rootEntries) { entry in
                                WorkspaceTreeRow(
                                    entry: entry,
                                    depth: 0,
                                    state: state,
                                    daemonClient: daemonClient
                                )
                            }
                        }
                    }
                    .padding(.vertical, VSpacing.xs)
                }
            }
        }
        .background(VColor.backgroundSubtle)
    }
}

// MARK: - Tree Row

private struct WorkspaceTreeRow: View {
    let entry: WorkspaceTreeEntry
    let depth: Int
    @Bindable var state: WorkspaceBrowserState
    let daemonClient: DaemonClient

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
                HStack(spacing: VSpacing.xs) {
                    if entry.isDirectory {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundColor(VColor.textMuted)
                            .frame(width: 12)
                    } else {
                        Spacer().frame(width: 12)
                    }

                    Image(systemName: entry.isDirectory ? "folder.fill" : "doc.text")
                        .font(.system(size: 12))
                        .foregroundColor(entry.isDirectory ? VColor.iconAccent : VColor.textSecondary)

                    Text(entry.name)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    Spacer()
                }
                .padding(.leading, CGFloat(depth) * 16 + VSpacing.sm)
                .padding(.trailing, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)
                .contentShape(Rectangle())
                .background(isSelected ? VColor.navActive : Color.clear)
            }
            .buttonStyle(.plain)

            // Expanded children
            if entry.isDirectory && isExpanded {
                if let children = state.directoryCache[entry.path] {
                    ForEach(children) { child in
                        WorkspaceTreeRow(
                            entry: child,
                            depth: depth + 1,
                            state: state,
                            daemonClient: daemonClient
                        )
                    }
                }
            }
        }
    }

    private func handleTap() async {
        if entry.isDirectory {
            if isExpanded {
                state.expandedDirs.remove(entry.path)
            } else {
                state.expandedDirs.insert(entry.path)
                // Load children if not cached
                if state.directoryCache[entry.path] == nil {
                    if let response = await daemonClient.fetchWorkspaceTree(path: entry.path) {
                        state.directoryCache[entry.path] = response.entries
                    }
                }
            }
        } else {
            state.selectedFilePath = entry.path
            state.isLoadingFile = true
            state.selectedFileDetail = nil
            state.selectedFileDetail = await daemonClient.fetchWorkspaceFile(path: entry.path)
            state.isLoadingFile = false
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
                        .foregroundColor(VColor.textMuted)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let detail = state.selectedFileDetail {
                fileContent(detail)
            } else {
                emptyState
            }
        }
        .background(VColor.background)
    }

    private var emptyState: some View {
        VStack {
            Spacer()
            Image(systemName: "doc.text")
                .font(.system(size: 32))
                .foregroundColor(VColor.textMuted)
                .padding(.bottom, VSpacing.sm)
            Text("Select a file to view")
                .font(VFont.body)
                .foregroundColor(VColor.textMuted)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func fileContent(_ detail: WorkspaceFileResponse) -> some View {
        let mime = detail.mimeType.lowercased()

        if !detail.isBinary, detail.content != nil {
            textViewer(detail)
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

    private func textViewer(_ detail: WorkspaceFileResponse) -> some View {
        ScrollView([.horizontal, .vertical]) {
            Text(detail.content ?? "")
                .font(VFont.mono)
                .foregroundColor(VColor.textPrimary)
                .textSelection(.enabled)
                .padding(VSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func fileTooLarge(_ detail: WorkspaceFileResponse) -> some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            Image(systemName: "doc.text")
                .font(.system(size: 40))
                .foregroundColor(VColor.textMuted)

            VStack(spacing: VSpacing.sm) {
                Text(detail.name)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)

                Text("File too large to preview")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)

                Text(formatFileSize(detail.size))
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func imageViewer(_ detail: WorkspaceFileResponse) -> some View {
        Group {
            if let url = daemonClient.workspaceFileContentURL(path: detail.path) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .padding(VSpacing.md)
                    case .failure:
                        VStack {
                            Image(systemName: "exclamationmark.triangle")
                                .font(.system(size: 24))
                                .foregroundColor(VColor.warning)
                            Text("Failed to load image")
                                .font(VFont.body)
                                .foregroundColor(VColor.textMuted)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    case .empty:
                        ProgressView()
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    @unknown default:
                        EmptyView()
                    }
                }
            } else {
                Text("Unable to load image URL")
                    .font(VFont.body)
                    .foregroundColor(VColor.textMuted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func videoViewer(_ detail: WorkspaceFileResponse) -> some View {
        Group {
            if let url = daemonClient.workspaceFileContentURL(path: detail.path) {
                VideoPlayer(player: AVPlayer(url: url))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(VSpacing.md)
            } else {
                Text("Unable to load video URL")
                    .font(VFont.body)
                    .foregroundColor(VColor.textMuted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func binaryFallback(_ detail: WorkspaceFileResponse) -> some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            Image(systemName: "doc.fill")
                .font(.system(size: 40))
                .foregroundColor(VColor.textMuted)

            VStack(spacing: VSpacing.sm) {
                Text(detail.name)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)

                Text(formatFileSize(detail.size))
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)

                Text(detail.mimeType)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)

                Text("Modified: \(detail.modifiedAt)")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func formatFileSize(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}
