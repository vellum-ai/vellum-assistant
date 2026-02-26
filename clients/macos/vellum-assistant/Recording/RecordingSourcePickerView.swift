import SwiftUI
import VellumAssistantShared

/// Source picker view for selecting what to record (display or window).
///
/// Uses design system tokens (VColor, VFont, VSpacing, VRadius) for consistent styling.
/// When `sourcePreviewEnabled` is true, displays per-row thumbnails and a
/// larger preview pane above the source list.
struct RecordingSourcePickerView: View {
    @ObservedObject var viewModel: RecordingSourcePickerViewModel
    var onStart: (IPCRecordingOptions) -> Void
    var onCancel: () -> Void

    /// Row thumbnail size (80x50pt).
    private let rowThumbnailSize = CGSize(width: 80, height: 50)
    /// Preview pane height.
    private static let previewPaneHeight: CGFloat = 160

    var body: some View {
        VStack(spacing: 0) {
            // Header
            Text("Screen Recording")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)
                .padding(.top, VSpacing.xl)
                .padding(.bottom, VSpacing.md)

            // Scope picker (Display / Window)
            Picker("Capture", selection: $viewModel.captureScope) {
                ForEach(CaptureScope.allCases, id: \.self) { scope in
                    Text(scope.rawValue).tag(scope)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, VSpacing.xl)
            .padding(.bottom, VSpacing.lg)

            // Preview pane (only when feature flag is on)
            if viewModel.sourcePreviewEnabled {
                previewPane
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.bottom, VSpacing.md)
            }

            // Source list
            if viewModel.isLoading {
                Spacer()
                ProgressView("Loading sources...")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
            } else {
                sourceList
            }

            Divider()
                .background(VColor.surfaceBorder)

            // Audio toggle + buttons
            bottomBar
        }
        .frame(
            width: 420,
            height: viewModel.sourcePreviewEnabled ? 640 : 440
        )
        .background(VColor.background)
        .task {
            await viewModel.loadSources()
            await viewModel.loadPreviews()
        }
        .onChange(of: viewModel.captureScope) { _, _ in
            Task { await viewModel.loadPreviews() }
        }
    }

    // MARK: - Preview Pane

    /// Shows the currently selected source's thumbnail at a larger size
    /// above the source list.
    @ViewBuilder
    private var previewPane: some View {
        ZStack {
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.backgroundSubtle)

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

    @ViewBuilder
    private var sourceList: some View {
        ScrollView {
            VStack(spacing: VSpacing.xs) {
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
            .padding(.vertical, VSpacing.sm)
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
                if viewModel.sourcePreviewEnabled {
                    ThumbnailView(
                        thumbnail: window.thumbnail,
                        previewStatus: window.previewStatus,
                        size: rowThumbnailSize
                    )
                }

                Image(systemName: "macwindow")
                    .font(.system(size: 16))
                    .foregroundColor(isSelected ? VColor.accent : VColor.textSecondary)
                    .frame(width: 24)

                VStack(alignment: .leading, spacing: 2) {
                    Text(window.title)
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textPrimary)
                        .lineLimit(1)
                    Text(window.appName)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .lineLimit(1)
                }

                Spacer()

                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.accent)
                }
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isSelected ? VColor.accent.opacity(0.1) : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(isSelected ? VColor.accent.opacity(0.3) : VColor.surfaceBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
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
                if viewModel.sourcePreviewEnabled {
                    ThumbnailView(
                        thumbnail: display.thumbnail,
                        previewStatus: display.previewStatus,
                        size: rowThumbnailSize
                    )
                }

                Image(systemName: "display")
                    .font(.system(size: 16))
                    .foregroundColor(isSelected ? VColor.accent : VColor.textSecondary)
                    .frame(width: 24)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: VSpacing.sm) {
                        Text(display.name)
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(1)
                        if display.isCurrentDisplay {
                            Text("This display")
                                .font(VFont.caption)
                                .foregroundColor(VColor.accent)
                                .padding(.horizontal, VSpacing.xs)
                                .padding(.vertical, 1)
                                .background(
                                    Capsule()
                                        .fill(VColor.accent.opacity(0.15))
                                )
                        }
                    }
                    Text(display.subtitle)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .lineLimit(1)
                }

                Spacer()

                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.accent)
                }
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isSelected ? VColor.accent.opacity(0.1) : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(isSelected ? VColor.accent.opacity(0.3) : VColor.surfaceBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func emptyState(_ message: String) -> some View {
        VStack(spacing: VSpacing.sm) {
            Image(systemName: "rectangle.dashed")
                .font(.system(size: 32))
                .foregroundColor(VColor.textMuted)
            Text(message)
                .font(VFont.body)
                .foregroundColor(VColor.textMuted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.xxl)
    }

    // MARK: - Bottom Bar

    private var bottomBar: some View {
        VStack(spacing: VSpacing.md) {
            // Audio toggles
            Toggle(isOn: $viewModel.includeAudio) {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "speaker.wave.2")
                        .foregroundColor(VColor.textSecondary)
                    Text("Include system audio")
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                }
            }
            .toggleStyle(.switch)
            .padding(.horizontal, VSpacing.xl)

            if #available(macOS 14, *) {
                Toggle(isOn: $viewModel.includeMicrophone) {
                    HStack(spacing: VSpacing.sm) {
                        Image(systemName: "mic")
                            .foregroundColor(VColor.textSecondary)
                        Text("Include microphone")
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                    }
                }
                .toggleStyle(.switch)
                .padding(.horizontal, VSpacing.xl)
            }

            // Buttons
            HStack(spacing: VSpacing.md) {
                Button("Cancel") {
                    onCancel()
                }
                .keyboardShortcut(.cancelAction)
                .buttonStyle(.bordered)

                Spacer()

                Button("Start Recording") {
                    onStart(viewModel.selectedRecordingOptions)
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .tint(Color(VColor.accent))
                .disabled(!viewModel.canStart)
            }
            .padding(.horizontal, VSpacing.xl)
        }
        .padding(.vertical, VSpacing.lg)
    }
}
