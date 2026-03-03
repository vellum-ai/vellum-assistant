import SwiftUI
import VellumAssistantShared

/// SwiftUI view for the command palette search overlay.
struct CommandPaletteView: View {
    @Bindable var viewModel: CommandPaletteViewModel
    var onDismiss: () -> Void
    var onSelectRecent: ((UUID) -> Void)?

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
                    .onSubmit {
                        executeSelected()
                    }

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

            // Results list
            let items = viewModel.allItems
            if items.isEmpty {
                emptyState
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        // Actions section
                        let actions = viewModel.filteredActions
                        if !actions.isEmpty {
                            sectionHeader("Actions")
                            ForEach(Array(actions.enumerated()), id: \.element.id) { index, action in
                                actionRow(action, isSelected: viewModel.selectedIndex == index)
                                    .onTapGesture {
                                        action.action()
                                        onDismiss()
                                    }
                            }
                        }

                        // Recent items section
                        let recents = viewModel.filteredRecents
                        if !recents.isEmpty {
                            sectionHeader("Recent")
                            let actionsCount = actions.count
                            ForEach(Array(recents.enumerated()), id: \.element.id) { index, recent in
                                recentRow(recent, isSelected: viewModel.selectedIndex == actionsCount + index)
                                    .onTapGesture {
                                        onSelectRecent?(recent.id)
                                        onDismiss()
                                    }
                            }
                        }
                    }
                    .padding(.vertical, VSpacing.xs)
                }
                .frame(maxHeight: 400)
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
        .onKeyPress(.upArrow) {
            viewModel.moveSelectionUp()
            return .handled
        }
        .onKeyPress(.downArrow) {
            viewModel.moveSelectionDown()
            return .handled
        }
        .onChange(of: viewModel.query) {
            viewModel.clampSelection()
        }
    }

    // MARK: - Sections

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(VFont.caption)
            .foregroundColor(VColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, VSpacing.lg)
            .padding(.top, VSpacing.sm)
            .padding(.bottom, VSpacing.xs)
    }

    // MARK: - Row Views

    private func actionRow(_ action: CommandPaletteAction, isSelected: Bool) -> some View {
        HStack(spacing: VSpacing.md) {
            Image(systemName: action.icon)
                .foregroundColor(VColor.textSecondary)
                .font(.system(size: 13))
                .frame(width: 20, alignment: .center)

            Text(action.label)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .lineLimit(1)

            Spacer()

            if let hint = action.shortcutHint {
                Text(hint)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .padding(.horizontal, VSpacing.xs)
                    .padding(.vertical, VSpacing.xxs)
                    .background(VColor.surfaceBorder.opacity(0.5))
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.xs))
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(isSelected ? VColor.surfaceBorder.opacity(0.5) : .clear)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .padding(.horizontal, VSpacing.xs)
        .contentShape(Rectangle())
    }

    private func recentRow(_ recent: CommandPaletteRecentItem, isSelected: Bool) -> some View {
        HStack(spacing: VSpacing.md) {
            Image(systemName: "bubble.left.and.bubble.right")
                .foregroundColor(VColor.textSecondary)
                .font(.system(size: 13))
                .frame(width: 20, alignment: .center)

            Text(recent.title)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .lineLimit(1)

            Spacer()

            Text(relativeTime(recent.lastInteracted))
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(isSelected ? VColor.surfaceBorder.opacity(0.5) : .clear)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .padding(.horizontal, VSpacing.xs)
        .contentShape(Rectangle())
    }

    private var emptyState: some View {
        VStack(spacing: VSpacing.sm) {
            Text("No results found.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .multilineTextAlignment(.center)
        }
        .padding(VSpacing.xl)
        .frame(maxWidth: .infinity)
    }

    // MARK: - Helpers

    private func executeSelected() {
        let items = viewModel.allItems
        guard viewModel.selectedIndex >= 0, viewModel.selectedIndex < items.count else { return }
        switch items[viewModel.selectedIndex] {
        case .action(let action):
            action.action()
            onDismiss()
        case .recent(let recent):
            onSelectRecent?(recent.id)
            onDismiss()
        }
    }

    private func relativeTime(_ date: Date) -> String {
        let interval = Date().timeIntervalSince(date)
        if interval < 60 { return "just now" }
        if interval < 3600 { return "\(Int(interval / 60))m ago" }
        if interval < 86400 { return "\(Int(interval / 3600))h ago" }
        return "\(Int(interval / 86400))d ago"
    }
}
