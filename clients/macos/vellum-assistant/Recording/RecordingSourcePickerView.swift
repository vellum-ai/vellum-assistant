import SwiftUI
import VellumAssistantShared

/// Source picker view for selecting what to record (display or window).
///
/// Uses design system tokens (VColor, VFont, VSpacing, VRadius) for consistent styling.
struct RecordingSourcePickerView: View {
    @ObservedObject var viewModel: RecordingSourcePickerViewModel
    var onStart: (IPCRecordingOptions) -> Void
    var onCancel: () -> Void

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
        .frame(width: 420, height: 440)
        .background(VColor.background)
        .task {
            await viewModel.loadSources()
        }
    }

    // MARK: - Source List

    @ViewBuilder
    private var sourceList: some View {
        ScrollView {
            VStack(spacing: VSpacing.xs) {
                switch viewModel.captureScope {
                case .display:
                    ForEach(viewModel.displays) { display in
                        sourceRow(
                            title: display.name,
                            subtitle: "\(display.width) x \(display.height)",
                            icon: "display",
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
                        sourceRow(
                            title: window.title,
                            subtitle: window.appName,
                            icon: "macwindow",
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

    private func sourceRow(
        title: String,
        subtitle: String,
        icon: String,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: VSpacing.md) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundColor(isSelected ? VColor.accent : VColor.textSecondary)
                    .frame(width: 24)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textPrimary)
                        .lineLimit(1)
                    Text(subtitle)
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
            // Audio toggle
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
