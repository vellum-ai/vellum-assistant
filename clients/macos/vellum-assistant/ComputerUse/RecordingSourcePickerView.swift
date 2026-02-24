import SwiftUI
import VellumAssistantShared

struct RecordingSourcePickerView: View {
    @ObservedObject var viewModel: RecordingSourcePickerViewModel
    let onStart: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Header
            Text("Select Recording Source")
                .font(VFont.headline)
                .foregroundColor(VColor.textPrimary)

            // Scope segmented control
            VSegmentedControl(
                items: CaptureScope.allCases.map { $0.rawValue.capitalized },
                selection: scopeBinding
            )

            // Source list
            ScrollView {
                VStack(spacing: VSpacing.sm) {
                    if viewModel.captureScope == .display {
                        displayList
                    } else {
                        windowList
                    }
                }
            }
            .frame(maxHeight: 240)

            Divider()
                .background(VColor.surfaceBorder)

            // Toggles
            VStack(alignment: .leading, spacing: VSpacing.md) {
                VToggle(isOn: $viewModel.includeAudio, label: "Include system audio")

                VToggle(isOn: $viewModel.rememberChoice, label: "Remember this choice")
            }

            Divider()
                .background(VColor.surfaceBorder)

            // Action buttons
            HStack {
                Spacer()

                VButton(label: "Cancel", style: .tertiary, size: .medium) {
                    onCancel()
                }

                VButton(label: "Start Recording", style: .primary, size: .medium, isDisabled: !hasValidSelection) {
                    if viewModel.rememberChoice {
                        viewModel.savePreference()
                    }
                    onStart()
                }
            }
        }
        .padding(VSpacing.lg)
        .background(VColor.background)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .frame(width: 420, height: 440)
        .onAppear {
            viewModel.enumerateDisplays()
            if viewModel.captureScope == .window {
                viewModel.enumerateWindows()
            }
        }
        .onChange(of: viewModel.captureScope) { _ in
            if viewModel.captureScope == .window {
                viewModel.enumerateWindows()
            }
        }
    }

    // MARK: - Display List

    private var displayList: some View {
        ForEach(viewModel.displays) { display in
            sourceRow(
                title: display.name,
                subtitle: display.resolution + (display.isMain ? " (Main)" : ""),
                icon: "display",
                isSelected: viewModel.selectedDisplayId == display.id
            ) {
                viewModel.selectedDisplayId = display.id
            }
        }
    }

    // MARK: - Window List

    private var windowList: some View {
        Group {
            if viewModel.windows.isEmpty {
                VStack(spacing: VSpacing.sm) {
                    Text("No windows found")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Text("Open an application window and try again.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                .frame(maxWidth: .infinity)
                .padding(VSpacing.lg)
            } else {
                ForEach(viewModel.windows) { window in
                    sourceRow(
                        title: window.name,
                        subtitle: window.ownerName,
                        icon: "macwindow",
                        isSelected: viewModel.selectedWindowId == window.id
                    ) {
                        viewModel.selectedWindowId = window.id
                    }
                }
            }
        }
    }

    // MARK: - Source Row

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

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text(title)
                        .font(VFont.body)
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
                        .font(.system(size: 16))
                }
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isSelected ? VColor.accentSubtle : .clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(isSelected ? VColor.accent.opacity(0.3) : .clear, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title), \(subtitle)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    // MARK: - Helpers

    private var scopeBinding: Binding<Int> {
        Binding<Int>(
            get: {
                CaptureScope.allCases.firstIndex(of: viewModel.captureScope) ?? 0
            },
            set: { newIndex in
                if newIndex < CaptureScope.allCases.count {
                    viewModel.captureScope = CaptureScope.allCases[newIndex]
                }
            }
        )
    }

    private var hasValidSelection: Bool {
        switch viewModel.captureScope {
        case .display:
            return viewModel.selectedDisplayId != nil
        case .window:
            return viewModel.selectedWindowId != nil
        }
    }
}

// MARK: - Preview

#if DEBUG
struct RecordingSourcePickerView_Preview: PreviewProvider {
    static var previews: some View {
        RecordingSourcePickerPreviewWrapper()
            .frame(width: 420, height: 440)
            .previewDisplayName("RecordingSourcePickerView")
    }
}

private struct RecordingSourcePickerPreviewWrapper: View {
    @StateObject private var viewModel = RecordingSourcePickerViewModel()

    var body: some View {
        RecordingSourcePickerView(
            viewModel: viewModel,
            onStart: {},
            onCancel: {}
        )
    }
}
#endif
