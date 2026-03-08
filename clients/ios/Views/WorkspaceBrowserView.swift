#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct WorkspaceBrowserView: View {
    let client: DaemonClient?
    var initialPath: String = ""

    @State private var entries: [WorkspaceTreeEntry] = []
    @State private var isLoading = true
    @State private var selectedFile: WorkspaceTreeEntry?

    var body: some View {
        Group {
            if isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if entries.isEmpty {
                VStack(spacing: VSpacing.md) {
                    VIconView(.folder, size: 36)
                        .foregroundColor(VColor.textMuted)
                        .accessibilityHidden(true)
                    Text("Empty directory")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(entries) { entry in
                        if entry.isDirectory {
                            NavigationLink(value: entry) {
                                directoryRow(entry)
                            }
                        } else {
                            Button { selectedFile = entry } label: {
                                fileRow(entry)
                            }
                        }
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle(initialPath.isEmpty ? "Workspace" : lastPathComponent(initialPath))
        .navigationDestination(for: WorkspaceTreeEntry.self) { entry in
            WorkspaceBrowserView(client: client, initialPath: entry.path)
        }
        .sheet(item: $selectedFile) { file in
            WorkspaceFileSheet(filePath: file.path, mimeType: file.mimeType, client: client)
        }
        .task { await loadDirectory() }
    }

    // MARK: - Row Views

    private func directoryRow(_ entry: WorkspaceTreeEntry) -> some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.folder, size: 16)
                .foregroundColor(VColor.accent)
                .frame(width: 24)
                .accessibilityHidden(true)

            Text(entry.name)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

            Spacer()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(entry.name), directory")
    }

    private func fileRow(_ entry: WorkspaceTreeEntry) -> some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(iconForMimeType(entry.mimeType), size: 16)
                .foregroundColor(VColor.accent)
                .frame(width: 24)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)

                if let size = entry.size {
                    Text(formatFileSize(size))
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }

            Spacer()

            VIconView(.chevronRight, size: 12)
                .foregroundColor(VColor.textMuted)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(entry.name)
        .accessibilityHint("Opens file viewer")
    }

    // MARK: - Helpers

    private func loadDirectory() async {
        guard let client else {
            isLoading = false
            return
        }

        if let response = await client.fetchWorkspaceTree(path: initialPath) {
            entries = response.entries
        }
        isLoading = false
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

    private func formatFileSize(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        let kb = Double(bytes) / 1024.0
        if kb < 1024 { return String(format: "%.1f KB", kb) }
        let mb = kb / 1024.0
        if mb < 1024 { return String(format: "%.1f MB", mb) }
        let gb = mb / 1024.0
        return String(format: "%.1f GB", gb)
    }
}
#endif
