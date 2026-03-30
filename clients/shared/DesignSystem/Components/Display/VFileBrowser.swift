#if os(macOS)
import SwiftUI

// MARK: - File Browser Model

public struct VFileBrowserFile: Identifiable {
    public let id: String
    public let name: String
    public let path: String
    public let size: Int
    public let mimeType: String
    public let isBinary: Bool
    public let content: String?
    public let icon: VIcon

    public init(
        id: String,
        name: String,
        path: String,
        size: Int,
        mimeType: String,
        isBinary: Bool,
        content: String?,
        icon: VIcon
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.size = size
        self.mimeType = mimeType
        self.isBinary = isBinary
        self.content = content
        self.icon = icon
    }
}

// MARK: - VFileBrowser

/// A two-pane file browser with a searchable file list on the left and
/// caller-provided content on the right. Both panes use bordered card
/// styling matching the Figma spec.
///
/// The right pane content is provided via a `@ViewBuilder` closure so
/// callers in the macOS target can pass `FileContentView` (which lives
/// in VellumAssistantLib, not the shared module).
public struct VFileBrowser<ContentPane: View>: View {
    let files: [VFileBrowserFile]
    @Binding var selectedPath: String?
    var sidebarWidth: CGFloat
    let contentPane: (VFileBrowserFile?) -> ContentPane

    @State private var searchText: String = ""

    public init(
        files: [VFileBrowserFile],
        selectedPath: Binding<String?>,
        sidebarWidth: CGFloat = 220,
        @ViewBuilder contentPane: @escaping (VFileBrowserFile?) -> ContentPane
    ) {
        self.files = files
        self._selectedPath = selectedPath
        self.sidebarWidth = sidebarWidth
        self.contentPane = contentPane
    }

    private var filteredFiles: [VFileBrowserFile] {
        if searchText.isEmpty { return files }
        return files.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    private var selectedFile: VFileBrowserFile? {
        guard let path = selectedPath else { return nil }
        return files.first { $0.path == path }
    }

    public var body: some View {
        HStack(spacing: VSpacing.md) {
            sidebarPane
            rightPane
        }
    }

    // MARK: - Sidebar Pane

    private var sidebarPane: some View {
        VStack(spacing: VSpacing.sm) {
            VSearchBar(placeholder: "Search files", text: $searchText)

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(filteredFiles) { file in
                        fileRow(file)
                    }
                }
            }
        }
        .padding(VSpacing.md)
        .frame(width: sidebarWidth)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .strokeBorder(VColor.borderDisabled, lineWidth: 2)
        )
    }

    // MARK: - File Row

    private func fileRow(_ file: VFileBrowserFile) -> some View {
        let isActive = selectedPath == file.path
        return Button {
            selectedPath = file.path
        } label: {
            HStack(spacing: VSpacing.sm) {
                VIconView(file.icon, size: 14)
                    .foregroundStyle(VColor.primaryBase)

                Text(file.name)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer()

                Text(formatFileSize(file.size))
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isActive ? VColor.surfaceActive : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(file.name)
        .accessibilityHint(isActive ? "Selected" : "Tap to select")
    }

    // MARK: - Right Pane

    private var rightPane: some View {
        contentPane(selectedFile)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(VColor.surfaceOverlay)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.xl)
                    .strokeBorder(VColor.borderDisabled, lineWidth: 2)
            )
    }
}
#endif
