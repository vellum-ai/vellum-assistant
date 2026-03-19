import AppKit
import SwiftUI
import VellumAssistantShared

// MARK: - File View Mode

enum FileViewMode: String, Hashable {
    case source
    case preview
    case tree
}

func availableViewModes(for fileName: String, mimeType: String) -> [FileViewMode] {
    let ext = (fileName as NSString).pathExtension.lowercased()
    let mime = mimeType.lowercased()
    if ext == "md" || ext == "markdown" || mime == "text/markdown" {
        return [.preview, .source]
    }
    if ext == "json" || mime.hasPrefix("application/json") {
        return [.tree, .source]
    }
    return [.source]
}

/// Returns the preferred default view mode for a file based on its name and MIME type.
/// Unlike `availableViewModes`, this picks the single best initial mode rather than listing all options.
func defaultViewMode(for fileName: String, mimeType: String) -> FileViewMode {
    let modes = availableViewModes(for: fileName, mimeType: mimeType)
    return modes.first ?? .source
}

func viewModeLabel(_ mode: FileViewMode) -> String {
    switch mode {
    case .source: return "Source"
    case .preview: return "Preview"
    case .tree: return "Preview"
    }
}

// MARK: - File Icon

func fileIcon(for mimeType: String) -> VIcon {
    if mimeType.hasPrefix("image/") { return .image }
    if mimeType.hasPrefix("video/") { return .video }
    if mimeType.hasPrefix("text/") { return .fileText }
    if mimeType == "application/json" || mimeType == "application/javascript" || mimeType == "application/typescript" { return .fileCode }
    return .file
}

// MARK: - File Content View

struct FileContentView: View {
    let fileName: String
    let mimeType: String
    @Binding var content: String
    @Binding var viewMode: FileViewMode
    var isEditable: Bool = false
    var showReadOnlyBadge: Bool = false
    var onTextChange: ((String) -> Void)? = nil
    @Binding var isActivelyEditing: Bool
    /// Unique identity for the file, used to force SwiftUI to recreate the
    /// HighlightedTextView when the underlying file changes. Defaults to
    /// `fileName`, but callers should pass a full path when the display name
    /// alone is not unique (e.g. files with the same basename in different
    /// directories).
    var fileIdentity: String? = nil
    @State private var isContentHovered = false
    @State private var isOverlayHovered = false
    @State private var expandAllTrigger = 0
    @State private var collapseAllTrigger = 0
    @State private var isTreeExpanded = false

    private func syncViewMode() {
        let modes = availableViewModes(for: fileName, mimeType: mimeType)
        if !modes.contains(viewMode) {
            viewMode = modes.first ?? .source
        }
    }

    var body: some View {
        let modes = availableViewModes(for: fileName, mimeType: mimeType)

        VStack(alignment: .leading, spacing: 0) {
            FileContentHeaderBar(
                icon: fileIcon(for: mimeType),
                fileName: fileName
            ) {
                if modes.count > 1 {
                    VSegmentedControl(
                        items: modes.map { (label: viewModeLabel($0), tag: $0) },
                        selection: $viewMode,
                        style: .pill,
                        size: .compact
                    )
                    .fixedSize()
                }

                if showReadOnlyBadge {
                    Text("Read-only")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
            }

            Divider().background(VColor.borderBase)

            ZStack(alignment: .topTrailing) {
                switch viewMode {
                case .source:
                    HighlightedTextView(
                        text: isEditable ? $content : .constant(content),
                        language: SyntaxLanguage.detect(fileName: fileName, mimeType: mimeType),
                        isEditable: isEditable,
                        isActivelyEditing: $isActivelyEditing,
                        onTextChange: onTextChange
                    )
                    .id(fileIdentity ?? fileName)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .preview:
                    MarkdownPreviewView(content: content)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                case .tree:
                    JSONTreeView(
                        content: content,
                        expandAllTrigger: expandAllTrigger,
                        collapseAllTrigger: collapseAllTrigger
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }

                if isContentHovered && !isActivelyEditing {
                    hoverOverlay
                }
            }
            .onHover { hovering in
                isContentHovered = hovering
            }
        }
        .onChange(of: viewMode) { _, newMode in
            if newMode != .source { isActivelyEditing = false }
            let modes = availableViewModes(for: fileName, mimeType: mimeType)
            guard modes.count > 1 else { return }
            let preference = newMode == .source ? "source" : "preview"
            UserDefaults.standard.set(preference, forKey: "fileViewerPreferredMode")
        }
        .onChange(of: fileName) { _, _ in
            isActivelyEditing = false
            isTreeExpanded = false
            syncViewMode()
        }
        .onAppear { syncViewMode() }
        .onChange(of: mimeType) { syncViewMode() }
    }

    // MARK: - Hover Overlay

    /// Floating toolbar shown on hover over the file content area.
    /// Source mode: Edit + Copy. Tree mode: Expand All + Collapse All + Copy.
    /// Preview mode: Copy only.
    @ViewBuilder
    private var hoverOverlay: some View {
        HStack(spacing: VSpacing.xs) {
            if isEditable && viewMode == .source {
                VButton(
                    label: "Edit",
                    iconOnly: VIcon.pencil.rawValue,
                    style: .ghost,
                    iconSize: 28,
                    tooltip: "Edit"
                ) {
                    isActivelyEditing = true
                }
            }

            if viewMode == .tree {
                VButton(
                    label: isTreeExpanded ? "Collapse All" : "Expand All",
                    iconOnly: (isTreeExpanded ? VIcon.minimize : VIcon.maximize).rawValue,
                    style: .ghost,
                    iconSize: 28,
                    tooltip: isTreeExpanded ? "Collapse All" : "Expand All"
                ) {
                    if isTreeExpanded {
                        collapseAllTrigger += 1
                    } else {
                        expandAllTrigger += 1
                    }
                    isTreeExpanded.toggle()
                }
            }

            VCopyButton(text: content, iconSize: 28, accessibilityHint: "Copy all")
        }
        .padding(VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceOverlay.opacity(0.9))
        )
        .onHover { hovering in
            // Use NSCursor.push()/pop() to force the pointing-hand cursor.
            // SwiftUI's .pointerStyle/.pointerCursor() and NSViewRepresentable
            // cursor-rect approaches are all overridden by NSTextView's own
            // cursor tracking when the overlay sits above a VCodeView. The
            // application cursor stack (push/pop) operates at a higher level
            // and is not subject to cursor-rect priority ordering.
            if hovering {
                NSCursor.pointingHand.push()
                isOverlayHovered = true
            } else if isOverlayHovered {
                NSCursor.pop()
                isOverlayHovered = false
            }
        }
        .onDisappear {
            if isOverlayHovered {
                NSCursor.pop()
                isOverlayHovered = false
            }
        }
        .padding(VSpacing.sm)
    }
}

// MARK: - File Content Header Bar

/// Header bar showing file icon and name for file content viewers.
struct FileContentHeaderBar<Trailing: View>: View {
    let icon: VIcon
    let fileName: String
    let trailing: Trailing

    init(icon: VIcon, fileName: String, @ViewBuilder trailing: () -> Trailing = { EmptyView() }) {
        self.icon = icon
        self.fileName = fileName
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(icon, size: 12)
                .foregroundColor(VColor.primaryBase)
            Text(fileName)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.contentDefault)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            trailing
        }
        .padding(.horizontal, VSpacing.sm)
        .frame(height: 36)
    }
}
