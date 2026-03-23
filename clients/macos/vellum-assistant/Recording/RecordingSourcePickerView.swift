import SwiftUI
import VellumAssistantShared

/// Source picker view for selecting what to record (display or window).
///
/// Uses design system tokens (VColor, VFont, VSpacing, VRadius) for consistent styling.
/// Displays per-row thumbnails and a larger preview pane above the source list.
struct RecordingSourcePickerView: View {
    @ObservedObject var viewModel: RecordingSourcePickerViewModel
    var onStart: (RecordingOptions) -> Void
    var onCancel: () -> Void

    @State private var hoveredDisplayId: UInt32?
    @State private var hoveredWindowId: Int?

    /// Row thumbnail size (80x50pt).
    private let rowThumbnailSize = CGSize(width: 80, height: 50)
    /// Preview pane height.
    private static let previewPaneHeight: CGFloat = 160

    var body: some View {
        VStack(spacing: 0) {
            // Header
            Text("Screen Recording")
                .font(VFont.title)
                .foregroundColor(VColor.contentDefault)
                .padding(.top, VSpacing.sm)
                .padding(.bottom, VSpacing.sm)

            Text("Choose what to record")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .padding(.bottom, VSpacing.sm)

            // Scope picker (Display / Window)
            VSegmentedControl(
                items: CaptureScope.allCases.map { (label: $0.rawValue, tag: $0) },
                selection: $viewModel.captureScope,
                style: .pill
            )
            .padding(.horizontal, VSpacing.lg)
            .padding(.bottom, VSpacing.sm)

            // Preview pane
            previewPane
                .padding(.horizontal, VSpacing.lg)
                .padding(.bottom, VSpacing.xs)

            // Source list
            if viewModel.isLoading {
                Spacer()
                ProgressView("Loading sources...")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
                Spacer()
            } else {
                sourceList
                    .padding(.bottom, VSpacing.xs)
            }

            Divider()
                .background(VColor.borderBase)

            // Audio toggle + buttons
            bottomBar
        }
        .frame(width: 420)
        .background(VColor.surfaceBase)
        .task {
            await viewModel.loadSources()
            await viewModel.loadPreviews()
        }
        .onChange(of: viewModel.captureScope) { _, _ in
            Task { await viewModel.loadPreviews() }
            viewModel.updateWindowSize()
        }
        .onChange(of: viewModel.isLoading) { _, newValue in
            if !newValue {
                viewModel.updateWindowSize()
            }
        }
    }

    // MARK: - Preview Pane

    /// Shows the currently selected source's thumbnail at a larger size
    /// above the source list.
    @ViewBuilder
    private var previewPane: some View {
        ZStack {
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceBase)

            ThumbnailView(
                thumbnail: viewModel.selectedThumbnail,
                previewStatus: viewModel.selectedPreviewStatus,
                size: CGSize(
                    width: 420 - VSpacing.lg * 2 - VSpacing.lg * 2,
                    height: Self.previewPaneHeight - VSpacing.md * 2
                )
            )
        }
        .frame(height: Self.previewPaneHeight)
    }

    // MARK: - Source List

    /// The rows of source items (display or window) without a scroll wrapper.
    @ViewBuilder
    private var sourceListContent: some View {
        VStack(spacing: VSpacing.sm) {
            switch viewModel.captureScope {
            case .display:
                ForEach(viewModel.displays) { display in
                    displayRow(
                        display: display,
                        isSelected: viewModel.selectedDisplayId == display.id
                    ) {
                        viewModel.selectedDisplayId = display.id
                    }
                }
                if viewModel.displays.isEmpty {
                    emptyState("No displays available")
                }

            case .window:
                ForEach(viewModel.windows) { window in
                    windowRow(
                        window: window,
                        isSelected: viewModel.selectedWindowId == window.id
                    ) {
                        viewModel.selectedWindowId = window.id
                    }
                }
                if viewModel.windows.isEmpty {
                    emptyState("No windows available")
                }
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.xs)
        .animation(VAnimation.fast, value: hoveredDisplayId)
        .animation(VAnimation.fast, value: hoveredWindowId)
    }

    /// Source list that hugs content when items fit, scrolls when they overflow.
    @ViewBuilder
    private var sourceList: some View {
        ViewThatFits(in: .vertical) {
            sourceListContent
            ScrollView {
                sourceListContent
                    .background(ScrollViewScrollerHider())
            }
            .scrollIndicators(.hidden)
        }
    }

    /// Row for a window source. When preview is enabled, shows a thumbnail
    /// to the left of the text content.
    private func windowRow(
        window: WindowSource,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: VSpacing.md) {
                ThumbnailView(
                    thumbnail: window.thumbnail,
                    previewStatus: window.previewStatus,
                    size: rowThumbnailSize
                )

                VIconView(.appWindow, size: 16)
                    .foregroundColor(isSelected ? VColor.primaryBase : VColor.contentSecondary)
                    .frame(width: 24)

                VStack(alignment: .leading, spacing: 2) {
                    Text(window.title)
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentDefault)
                        .lineLimit(1)
                    if !window.appName.isEmpty {
                        Text(window.appName)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                            .lineLimit(1)
                    }
                }

                Spacer()

                if isSelected {
                    VIconView(.circleCheck, size: 18)
                        .foregroundColor(VColor.primaryBase)
                }
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.md)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isSelected ? VColor.primaryBase.opacity(0.1) : (hoveredWindowId == window.id ? VColor.surfaceBase : Color.clear))
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(isSelected ? VColor.primaryBase.opacity(0.3) : VColor.borderBase, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            if hovering {
                hoveredWindowId = window.id
            } else if hoveredWindowId == window.id {
                hoveredWindowId = nil
            }
        }
    }

    /// Row for a display source showing name, resolution + scale, and a badge
    /// when this is the display the picker window is on. When preview is
    /// enabled, shows a thumbnail to the left of the text content.
    private func displayRow(
        display: DisplaySource,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: VSpacing.md) {
                ThumbnailView(
                    thumbnail: display.thumbnail,
                    previewStatus: display.previewStatus,
                    size: rowThumbnailSize
                )

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: VSpacing.sm) {
                        Text(display.name)
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.contentDefault)
                            .lineLimit(1)
                        if display.isCurrentDisplay {
                            VTag("This display", color: VColor.primaryBase)
                        }
                    }
                    Text(display.subtitle)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                        .lineLimit(1)
                }

                Spacer()

                if isSelected {
                    VIconView(.circleCheck, size: 18)
                        .foregroundColor(VColor.primaryBase)
                }
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.md)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isSelected ? VColor.primaryBase.opacity(0.1) : (hoveredDisplayId == display.id ? VColor.surfaceBase : Color.clear))
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(isSelected ? VColor.primaryBase.opacity(0.3) : VColor.borderBase, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            if hovering {
                hoveredDisplayId = display.id
            } else if hoveredDisplayId == display.id {
                hoveredDisplayId = nil
            }
        }
    }

    private func emptyState(_ message: String) -> some View {
        VStack(spacing: VSpacing.sm) {
            VIconView(.squareDashed, size: 32)
                .foregroundColor(VColor.contentTertiary)
            Text(message)
                .font(VFont.body)
                .foregroundColor(VColor.contentTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.xxl)
    }

    // MARK: - Bottom Bar

    private var bottomBar: some View {
        VStack(spacing: VSpacing.lg) {
            // Audio toggles — toggle left, icon + text right
            HStack(spacing: VSpacing.sm) {
                VToggle(isOn: $viewModel.includeAudio)
                    .accessibilityLabel("System audio")
                VIconView(.volume2, size: 14)
                    .foregroundColor(VColor.contentSecondary)
                    .frame(width: 20)
                Text("System audio")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
            }
            .padding(.horizontal, VSpacing.xl)

            if #available(macOS 14, *) {
                HStack(spacing: VSpacing.sm) {
                    VToggle(isOn: $viewModel.includeMicrophone)
                        .accessibilityLabel("Microphone")
                    VIconView(.mic, size: 14)
                        .foregroundColor(VColor.contentSecondary)
                        .frame(width: 20)
                    Text("Microphone")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentDefault)
                }
                .padding(.horizontal, VSpacing.xl)
            }

            // Buttons
            HStack(spacing: VSpacing.md) {
                VButton(label: "Cancel", style: .outlined) {
                    onCancel()
                }
                Spacer()
                VButton(label: "Start Recording", style: .primary, isDisabled: !viewModel.canStart) {
                    onStart(viewModel.selectedRecordingOptions)
                }
            }
            .padding(.top, VSpacing.xs)
            .padding(.horizontal, VSpacing.xl)
            .background {
                // Hidden buttons for keyboard shortcuts
                Button("") { onCancel() }
                    .keyboardShortcut(.cancelAction)
                    .opacity(0)
                    .frame(width: 0, height: 0)
                    .accessibilityHidden(true)
                Button("") {
                    guard viewModel.canStart else { return }
                    onStart(viewModel.selectedRecordingOptions)
                }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!viewModel.canStart)
                    .opacity(0)
                    .frame(width: 0, height: 0)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, VSpacing.md)
    }
}

// MARK: - Scroll View Helpers

/// Finds the nearest NSScrollView ancestor and hides its scrollers,
/// overriding the macOS "Show scroll bars: Always" system preference.
/// Walks the full superview chain as a fallback if `enclosingScrollView`
/// returns nil (which can happen with SwiftUI's internal hosting layers).
private struct ScrollViewScrollerHider: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { hideScrollers(from: view) }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { hideScrollers(from: nsView) }
    }

    private func hideScrollers(from view: NSView) {
        // Try the fast path first
        if let scrollView = view.enclosingScrollView {
            scrollView.hasVerticalScroller = false
            scrollView.hasHorizontalScroller = false
            return
        }
        // Walk the full superview chain looking for any NSScrollView
        var current: NSView? = view.superview
        while let ancestor = current {
            if let scrollView = ancestor as? NSScrollView {
                scrollView.hasVerticalScroller = false
                scrollView.hasHorizontalScroller = false
                return
            }
            current = ancestor.superview
        }
    }
}

