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
        sidebarWidth: CGFloat = 280,
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
        HStack(spacing: VSpacing.sm) {
            sidebarPane
            rightPane
        }
    }

    // MARK: - Sidebar Pane

    private var sidebarPane: some View {
        VStack(spacing: VSpacing.xs) {
            VSearchBar(placeholder: "Search files", text: $searchText)

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(filteredFiles) { file in
                        VFileBrowserRow(
                            file: file,
                            isActive: selectedPath == file.path,
                            onSelect: { selectedPath = file.path }
                        )
                    }
                }
            }
        }
        .padding(VSpacing.md)
        .frame(width: sidebarWidth)
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .strokeBorder(VColor.borderHover, lineWidth: 1)
        )
    }

    // MARK: - Right Pane

    private var rightPane: some View {
        contentPane(selectedFile)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(VColor.surfaceLift)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.xl)
                    .strokeBorder(VColor.borderHover, lineWidth: 1)
            )
    }
}

// MARK: - File Row (with hover state like VNavItem)

private struct VFileBrowserRow: View {
    let file: VFileBrowserFile
    let isActive: Bool
    let onSelect: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: VSpacing.xs) {
                VIconView(file.icon, size: VSize.iconDefault)
                    .foregroundStyle(isActive ? VColor.primaryActive : VColor.primaryBase)
                    .frame(width: VSize.iconSlot, height: VSize.iconSlot)

                Text(file.name)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(isActive ? VColor.contentEmphasized : VColor.contentSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer()

                Text(formatFileSize(file.size))
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .padding(.leading, VSpacing.xs)
            .padding(.trailing, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .frame(minHeight: VSize.rowMinHeight)
            .background(
                isActive ? VColor.surfaceActive :
                isHovered ? VColor.surfaceBase :
                Color.clear
            )
            .animation(VAnimation.fast, value: isHovered)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .pointerCursor()
        .accessibilityLabel(file.name)
        .accessibilityHint(isActive ? "Selected" : "Tap to select")
    }
}
#endif
