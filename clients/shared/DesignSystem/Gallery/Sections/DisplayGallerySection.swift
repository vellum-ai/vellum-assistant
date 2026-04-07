#if DEBUG
import SwiftUI

struct DisplayGallerySection: View {
    var filter: String?

    @State private var waveformAmplitude: Float = 0.5
    @State private var waveformActive: Bool = true
    @State private var basicSectionExpanded: Bool = true
    @State private var subtitleSectionExpanded: Bool = false

    // VFileBrowser gallery state — independent per-scenario bindings so each
    // demo behaves on its own.
    #if os(macOS)
    @State private var fileBrowserEagerExpanded: Set<String> = ["src", "src/components"]
    @State private var fileBrowserEagerSelected: String? = "README.md"
    @State private var fileBrowserLazyExpanded: Set<String> = ["src"]
    @State private var fileBrowserLazySelected: String? = nil
    @State private var fileBrowserSearchExpanded: Set<String> = []
    @State private var fileBrowserSearchSelected: String? = nil
    @State private var fileBrowserHeaderExpanded: Set<String> = ["src"]
    @State private var fileBrowserHeaderSelected: String? = "src/main.swift"
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            if filter == nil || filter == "vCard" {
                // MARK: - VCard
                GallerySectionHeader(
                    title: "VCard",
                    description: "Container with surface background, border, and 16pt padding.",
                    useInsteadOf: "Manual padding + background + cornerRadius"
                )

                VCard {
                    Text("Default card with 16pt padding")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentDefault)
                }

                // Action variants (tappable cards with hover highlight)
                Text("Action Variants")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentSecondary)

                VCard(action: {}) {
                    HStack(spacing: VSpacing.lg) {
                        VIconView(.zap, size: 20)
                            .foregroundStyle(VColor.primaryBase)
                            .frame(width: 40, height: 40)
                        VStack(alignment: .leading, spacing: VSpacing.sm) {
                            Text("Tappable Card")
                                .font(VFont.bodyMediumEmphasised)
                                .foregroundStyle(VColor.contentDefault)
                            Text("Pass an action to VCard for hover highlight and tap behavior.")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentSecondary)
                                .lineLimit(2)
                        }
                    }
                }

                HStack(spacing: VSpacing.lg) {
                    VCard(action: {}) {
                        HStack(spacing: VSpacing.md) {
                            VIconView(.brain, size: 20)
                                .foregroundStyle(VColor.systemNegativeStrong)
                                .frame(width: 40, height: 40)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Memory Item")
                                    .font(VFont.bodyMediumEmphasised)
                                    .foregroundStyle(VColor.contentDefault)
                                Text("A remembered fact about the user.")
                                    .font(VFont.bodyMediumLighter)
                                    .foregroundStyle(VColor.contentTertiary)
                                    .lineLimit(1)
                            }
                        }
                    }

                    VCard(action: {}) {
                        HStack(spacing: VSpacing.md) {
                            VIconView(.fileText, size: 20)
                                .foregroundStyle(VColor.primaryBase)
                                .frame(width: 40, height: 40)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Document")
                                    .font(VFont.bodyMediumEmphasised)
                                    .foregroundStyle(VColor.contentDefault)
                                Text("An uploaded reference document.")
                                    .font(VFont.bodyMediumLighter)
                                    .foregroundStyle(VColor.contentTertiary)
                                    .lineLimit(1)
                            }
                        }
                    }
                }

            }

            if filter == nil || filter == "vEmptyState" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VEmptyState
                GallerySectionHeader(
                    title: "VEmptyState",
                    description: "Centered placeholder for empty content areas."
                )

                HStack(spacing: VSpacing.lg) {
                    VCard {
                        VEmptyState(
                            title: "No items",
                            subtitle: "Create your first item to get started",
                            icon: "tray"
                        )
                        .frame(height: 200)
                    }
                    VCard {
                        VEmptyState(title: "No results")
                            .frame(height: 200)
                    }
                    VCard {
                        VEmptyState(
                            title: "Empty inbox",
                            icon: VIcon.mail.rawValue
                        )
                        .frame(height: 200)
                    }
                }

                Text("With Action Button")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentSecondary)

                HStack(spacing: VSpacing.lg) {
                    VCard {
                        VEmptyState(
                            title: "No contacts yet",
                            icon: VIcon.users.rawValue,
                            actionLabel: "Add Contact",
                            actionIcon: VIcon.plus.rawValue,
                            action: {}
                        )
                        .frame(height: 200)
                    }
                    VCard {
                        VEmptyState(
                            title: "No documents",
                            subtitle: "Upload a file to get started",
                            icon: VIcon.fileText.rawValue,
                            actionLabel: "Upload",
                            action: {}
                        )
                        .frame(height: 200)
                    }
                }

            }

            if filter == nil || filter == "vDisclosureSection" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VDisclosureSection
                GallerySectionHeader(
                    title: "VDisclosureSection",
                    description: "Full-row clickable disclosure with animated chevron. Replaces DisclosureGroup.",
                    useInsteadOf: "Raw DisclosureGroup"
                )

                VDisclosureSection(
                    title: "Basic Section",
                    isExpanded: $basicSectionExpanded
                ) {
                    Text("Expanded content is visible")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                }
                .padding(VSpacing.lg)
                .vCard()

                VDisclosureSection(
                    title: "With Subtitle",
                    subtitle: "Additional context shown below the title",
                    isExpanded: $subtitleSectionExpanded
                ) {
                    Text("This content is hidden when collapsed")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                }
                .padding(VSpacing.lg)
                .vCard()

            }

            if filter == nil || filter == "vListRow" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VListRow
                GallerySectionHeader(
                    title: "VListRow",
                    description: "List item with hover highlight and optional tap action."
                )

                VCard(padding: 0) {
                    VStack(spacing: 0) {
                        VListRow(onTap: {}) {
                            HStack {
                                VIconView(.fileText, size: 14)
                                    .foregroundStyle(VColor.primaryBase)
                                Text("Tappable row with icon")
                                    .font(VFont.bodyMediumLighter)
                                    .foregroundStyle(VColor.contentDefault)
                                Spacer()
                                VIconView(.chevronRight, size: 10)
                                    .foregroundStyle(VColor.contentTertiary)
                            }
                        }

                        Divider().background(VColor.borderBase)

                        VListRow(onTap: {}) {
                            HStack {
                                VIconView(.folder, size: 14)
                                    .foregroundStyle(VColor.systemNegativeHover)
                                Text("Another tappable row")
                                    .font(VFont.bodyMediumLighter)
                                    .foregroundStyle(VColor.contentDefault)
                                Spacer()
                                VBadge(style: .count(3))
                            }
                        }

                        Divider().background(VColor.borderBase)

                        VListRow {
                            Text("Static row (no tap action)")
                                .font(VFont.bodyMediumLighter)
                                .foregroundStyle(VColor.contentSecondary)
                        }
                    }
                }
            }

            if filter == nil || filter == "vAvatarImage" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VAvatarImage
                #if os(macOS)
                GallerySectionHeader(
                    title: "VAvatarImage",
                    description: "Avatar with transparency-aware clip shape. Transparent images show full artwork; opaque images clip to a circle."
                )

                HStack(spacing: VSpacing.lg) {
                    ForEach([
                        ("24pt", CGFloat(24)),
                        ("28pt", CGFloat(28)),
                        ("40pt", CGFloat(40)),
                        ("52pt", CGFloat(52)),
                    ], id: \.0) { label, size in
                        VStack(spacing: VSpacing.xs) {
                            VAvatarImage(
                                image: NSImage(systemSymbolName: "person.circle.fill", accessibilityDescription: nil)!,
                                size: size
                            )
                            Text(label)
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentTertiary)
                        }
                    }
                }
                #endif

            }

            if filter == nil || filter == "vCodeView" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VCodeView
                #if os(macOS)
                GallerySectionHeader(
                    title: "VCodeView",
                    description: "Read-only code viewer with line numbers, search, and pluggable syntax highlighting. Wraps NSTextView for native text selection and copy."
                )

                VCard {
                    VCodeView(
                        text: """
                        func greet(name: String) -> String {
                            let message = "Hello, \\(name)!"
                            print(message)
                            return message
                        }

                        let result = greet(name: "World")
                        """
                    )
                    .frame(height: 200)
                }
                #endif

            }

            if filter == nil || filter == "vSelectableTextView" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VSelectableTextView
                #if os(macOS)
                GallerySectionHeader(
                    title: "VSelectableTextView",
                    description: "Read-only selectable text wrapping NSTextView for native text selection and copy in lazy containers."
                )

                VCard {
                    VSelectableTextView(
                        attributedString: NSAttributedString(
                            string: "This text is selectable. Try clicking and dragging to select, then Cmd+C to copy.",
                            attributes: [
                                .font: VFont.nsChat,
                                .foregroundColor: NSColor(VColor.contentDefault),
                            ]
                        ),
                        lineSpacing: 4
                    )
                    .padding(VSpacing.sm)
                }
                #endif

            }

            if filter == nil || filter == "vDiffView" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VDiffView
                GallerySectionHeader(
                    title: "VDiffView",
                    description: "Renders unified diff text with per-line colored backgrounds. Green for additions, red for removals, blue for hunk headers."
                )

                VCard {
                    VDiffView(Self.sampleDiff)
                        .padding(VSpacing.sm)
                }

                Text("With maxHeight constraint")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentSecondary)

                VCard {
                    VDiffView(Self.sampleDiff, maxHeight: 120)
                        .padding(VSpacing.sm)
                }

            }

            if filter == nil || filter == "vStreamingWaveform" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VStreamingWaveform
                GallerySectionHeader(
                    title: "VStreamingWaveform",
                    description: "Animated audio waveform driven by amplitude. Two styles: conversation (centered) and dictation (bottom-aligned)."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        HStack(spacing: VSpacing.xl) {
                            VStack(spacing: VSpacing.sm) {
                                Text("Conversation")
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentSecondary)
                                VStreamingWaveform(
                                    amplitude: waveformAmplitude,
                                    isActive: waveformActive,
                                    style: .conversation
                                )
                                .frame(width: 120, height: 60)
                            }

                            VStack(spacing: VSpacing.sm) {
                                Text("Dictation")
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentSecondary)
                                VStreamingWaveform(
                                    amplitude: waveformAmplitude,
                                    isActive: waveformActive,
                                    style: .dictation,
                                    foregroundColor: VColor.contentSecondary
                                )
                                .frame(width: 100, height: 30)
                            }
                        }

                        Divider().background(VColor.borderBase)

                        HStack {
                            Text("Amplitude: \(String(format: "%.2f", waveformAmplitude))")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentSecondary)
                            Slider(value: Binding(
                                get: { Double(waveformAmplitude) },
                                set: { waveformAmplitude = Float($0) }
                            ), in: 0...1)
                            .frame(maxWidth: 200)
                        }

                        Toggle("Active", isOn: $waveformActive)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentDefault)
                    }
                }
            }

            if filter == nil || filter == "vFileBrowser" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VFileBrowser
                #if os(macOS)
                GallerySectionHeader(
                    title: "VFileBrowser",
                    description: "Two-pane file browser with a tree-based file list, header actions slot, search with auto-expand, and caller-provided right pane content."
                )

                // Eager mode with a small tree
                Text("Eager — small tree")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentSecondary)

                VFileBrowser(
                    title: "Files",
                    rootNodes: Self.fileBrowserSampleTree,
                    expandedPaths: $fileBrowserEagerExpanded,
                    selectedPath: $fileBrowserEagerSelected
                ) { node in
                    fileBrowserContentPlaceholder(node)
                }
                .frame(height: 320)

                // Lazy mode with stub onExpand
                Text("Lazy — onExpand stub")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentSecondary)

                VFileBrowser(
                    title: "Workspace",
                    rootNodes: Self.fileBrowserSampleTree,
                    expandedPaths: $fileBrowserLazyExpanded,
                    selectedPath: $fileBrowserLazySelected,
                    onExpand: { _ in
                        // No-op in the gallery — real callers fetch children here.
                    }
                ) { node in
                    fileBrowserContentPlaceholder(node)
                }
                .frame(height: 320)

                // Search active showing auto-expanded matches
                Text("Search — auto-expand matches")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentSecondary)

                Text("Type a query into the search bar (try \"swift\") to see matching parents auto-expand even though the tree starts collapsed.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)

                VFileBrowser(
                    title: "Files",
                    rootNodes: Self.fileBrowserSampleTree,
                    expandedPaths: $fileBrowserSearchExpanded,
                    selectedPath: $fileBrowserSearchSelected
                ) { node in
                    fileBrowserContentPlaceholder(node)
                }
                .frame(height: 320)

                // Header with sample actions slot populated
                Text("Header — actions slot")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentSecondary)

                VFileBrowser(
                    title: "Workspace",
                    rootNodes: Self.fileBrowserSampleTree,
                    expandedPaths: $fileBrowserHeaderExpanded,
                    selectedPath: $fileBrowserHeaderSelected,
                    headerActions: {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.plus, size: 12)
                                .foregroundStyle(VColor.contentSecondary)
                            VIconView(.folderPlus, size: 12)
                                .foregroundStyle(VColor.contentSecondary)
                        }
                    },
                    rowContextMenu: { _ in EmptyView() }
                ) { node in
                    fileBrowserContentPlaceholder(node)
                }
                .frame(height: 320)
                #endif
            }

        }
    }

    // MARK: - VFileBrowser Helpers

    #if os(macOS)
    @ViewBuilder
    private func fileBrowserContentPlaceholder(_ node: VFileBrowserNode?) -> some View {
        if let node {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text(node.name)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                Text(node.path)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            VEmptyState(title: "Select a file", icon: VIcon.fileText.rawValue)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private static let fileBrowserSampleTree: [VFileBrowserNode] = [
        VFileBrowserNode(
            id: "src",
            name: "src",
            path: "src",
            isDirectory: true,
            children: [
                VFileBrowserNode(
                    id: "src/components",
                    name: "components",
                    path: "src/components",
                    isDirectory: true,
                    children: [
                        VFileBrowserNode(
                            id: "src/components/Button.swift",
                            name: "Button.swift",
                            path: "src/components/Button.swift",
                            isDirectory: false,
                            size: 1234,
                            icon: .fileCode
                        ),
                        VFileBrowserNode(
                            id: "src/components/Card.swift",
                            name: "Card.swift",
                            path: "src/components/Card.swift",
                            isDirectory: false,
                            size: 2345,
                            icon: .fileCode
                        )
                    ]
                ),
                VFileBrowserNode(
                    id: "src/main.swift",
                    name: "main.swift",
                    path: "src/main.swift",
                    isDirectory: false,
                    size: 567,
                    icon: .fileCode
                )
            ]
        ),
        VFileBrowserNode(
            id: "README.md",
            name: "README.md",
            path: "README.md",
            isDirectory: false,
            size: 890,
            icon: .fileText
        )
    ]
    #endif

    // MARK: - Sample Data

    private static let sampleDiff = """
    --- a/src/config.ts
    +++ b/src/config.ts
    @@ -10,7 +10,8 @@ export const config = {
       timeout: 5000,
    -  retries: 3,
    +  retries: 5,
    +  backoff: "exponential",
       verbose: false,
     };
    """
}

// MARK: - Component Page Router

extension DisplayGallerySection {
    @ViewBuilder
    static func componentPage(_ id: String) -> some View {
        switch id {
        case "vCard": DisplayGallerySection(filter: "vCard")

        case "vEmptyState": DisplayGallerySection(filter: "vEmptyState")
        case "vDisclosureSection": DisplayGallerySection(filter: "vDisclosureSection")
        case "vListRow": DisplayGallerySection(filter: "vListRow")
        case "vAvatarImage": DisplayGallerySection(filter: "vAvatarImage")
        case "vCodeView": DisplayGallerySection(filter: "vCodeView")
        case "vSelectableTextView": DisplayGallerySection(filter: "vSelectableTextView")
        case "vDiffView": DisplayGallerySection(filter: "vDiffView")
        case "vStreamingWaveform": DisplayGallerySection(filter: "vStreamingWaveform")
        case "vFileBrowser": DisplayGallerySection(filter: "vFileBrowser")
        default:
            if let factory = DisplayGallerySection.externalPageFactories[id] {
                AnyView(factory())
            } else {
                EmptyView()
            }
        }
    }

    /// Registry for platform-specific gallery pages (e.g. macOS-only AnimatedAvatarView).
    nonisolated(unsafe) static var externalPageFactories: [String: () -> AnyView] = [:]
}

/// Register an external gallery page factory for a component ID.
/// Used by the macOS target to inject platform-specific gallery pages.
public func registerDisplayGalleryPage(id: String, factory: @escaping () -> AnyView) {
    DisplayGallerySection.externalPageFactories[id] = factory
}
#endif
