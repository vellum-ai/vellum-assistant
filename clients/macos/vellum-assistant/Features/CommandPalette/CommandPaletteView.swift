import SwiftUI
import VellumAssistantShared

/// SwiftUI view for the command palette search overlay.
struct CommandPaletteView: View {
    @Bindable var viewModel: CommandPaletteViewModel
    var onDismiss: () -> Void

    @FocusState private var isSearchFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            // Search input
            HStack(spacing: VSpacing.md) {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(VColor.textMuted)
                    .font(.system(size: 16, weight: .medium))

                TextField("Search conversations, memories, schedules...", text: $viewModel.query)
                    .textFieldStyle(.plain)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .focused($isSearchFocused)

                if !viewModel.query.isEmpty {
                    Button {
                        viewModel.query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(VColor.textMuted)
                            .font(.system(size: 14))
                    }
                    .buttonStyle(.plain)
                }

                // Shortcut hint
                Text("\u{2318}K")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .padding(.horizontal, VSpacing.xs)
                    .padding(.vertical, VSpacing.xxs)
                    .background(VColor.surfaceBorder.opacity(0.5))
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.xs))
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)

            // Divider
            VColor.divider
                .frame(height: 1)

            // Empty state when no query
            if viewModel.query.isEmpty {
                emptyState
            }
        }
        .background(VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.3), radius: 20, y: 10)
        .frame(width: 600)
        .onAppear {
            isSearchFocused = true
        }
        .onKeyPress(.escape) {
            onDismiss()
            return .handled
        }
    }

    private var emptyState: some View {
        VStack(spacing: VSpacing.sm) {
            Text("Type to search across your conversations, memories, schedules, and contacts.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .multilineTextAlignment(.center)
        }
        .padding(VSpacing.xl)
        .frame(maxWidth: .infinity)
    }
}
