import SwiftUI
import VellumAssistantShared

/// SwiftUI view for the command palette search overlay.
struct CommandPaletteView: View {
    @Bindable var viewModel: CommandPaletteViewModel
    var onDismiss: () -> Void
    var onSelectRecent: ((UUID) -> Void)?
    var onSelectConversation: ((String) -> Void)?
    var onResizeNeeded: (() -> Void)?

    @FocusState private var isSearchFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            // Search input
            HStack(spacing: VSpacing.md) {
                if viewModel.isSearching {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 16, height: 16)
                } else {
                    VIconView(.search, size: 16)
                        .foregroundStyle(VColor.contentTertiary)
                }

                TextField("Search conversations, schedules...", text: $viewModel.query)
                    .textFieldStyle(.plain)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                    .focused($isSearchFocused)
                    .onSubmit {
                        executeSelected()
                    }

                if !viewModel.query.isEmpty {
                    Button {
                        viewModel.query = ""
                        viewModel.serverResults = .empty
                    } label: {
                        VIconView(.circleX, size: 14)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                }

                // Shortcut hint
                Text("\u{2318}K")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .padding(.horizontal, VSpacing.xs)
                    .padding(.vertical, VSpacing.xxs)
                    .background(VColor.borderBase.opacity(0.5))
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.xs))
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)

            // Divider
            VColor.borderBase
                .frame(height: 1)

            // Results list
            let items = viewModel.allItems
            if items.isEmpty && !viewModel.isSearching {
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
                            let recentsOffset = actions.count
                            sectionHeader("Recent")
                            ForEach(Array(recents.enumerated()), id: \.element.id) { index, recent in
                                recentRow(recent, isSelected: viewModel.selectedIndex == recentsOffset + index)
                                    .onTapGesture {
                                        onSelectRecent?(recent.id)
                                        onDismiss()
                                    }
                            }
                        }

                        // Server results sections
                        let serverOffset = actions.count + recents.count
                        serverResultsSections(startIndex: serverOffset)

                    }
                    .padding(.vertical, VSpacing.xs)
                    .animation(.easeInOut(duration: VAnimation.durationFast), value: viewModel.serverResults.conversations.count)
                }
                .frame(maxHeight: 400)
            }
        }
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .shadow(color: VColor.auxBlack.opacity(0.3), radius: 20, y: 10)
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
            viewModel.triggerSearch()
        }
        .onChange(of: viewModel.allItems.count) {
            onResizeNeeded?()
        }
        .onChange(of: viewModel.isSearching) {
            onResizeNeeded?()
        }
    }

    // MARK: - Sections

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(VFont.labelDefault)
            .foregroundStyle(VColor.contentTertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, VSpacing.lg)
            .padding(.top, VSpacing.sm)
            .padding(.bottom, VSpacing.xs)
    }

    // MARK: - Server Results Sections

    @ViewBuilder
    private func serverResultsSections(startIndex: Int) -> some View {
        let conversations = viewModel.serverResults.conversations
        let schedules = viewModel.serverResults.schedules
        let contacts = viewModel.serverResults.contacts

        var offset = startIndex

        if !conversations.isEmpty {
            let convOffset = offset
            sectionHeader("Conversations")
            ForEach(Array(conversations.enumerated()), id: \.element.id) { index, conv in
                conversationRow(conv, isSelected: viewModel.selectedIndex == convOffset + index)
                    .onTapGesture {
                        onSelectConversation?(conv.id)
                        onDismiss()
                    }
            }
            let _ = (offset += conversations.count)
        }

        if !schedules.isEmpty {
            let schedOffset = offset
            sectionHeader("Schedules")
            ForEach(Array(schedules.enumerated()), id: \.element.id) { index, schedule in
                scheduleRow(schedule, isSelected: viewModel.selectedIndex == schedOffset + index)
            }
            let _ = (offset += schedules.count)
        }

        if !contacts.isEmpty {
            let contactOffset = offset
            sectionHeader("Contacts")
            ForEach(Array(contacts.enumerated()), id: \.element.id) { index, contact in
                contactRow(contact, isSelected: viewModel.selectedIndex == contactOffset + index)
            }
        }
    }

    // MARK: - Row Views

    private func actionRow(_ action: CommandPaletteAction, isSelected: Bool) -> some View {
        HStack(spacing: VSpacing.md) {
            VIconView(.resolve(action.icon), size: 13)
                .foregroundStyle(VColor.contentSecondary)
                .frame(width: 20, alignment: .center)

            Text(action.label)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)

            Spacer()

            if let hint = action.shortcutHint {
                Text(hint)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .padding(.horizontal, VSpacing.xs)
                    .padding(.vertical, VSpacing.xxs)
                    .background(VColor.borderBase.opacity(0.5))
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.xs))
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(isSelected ? VColor.borderBase.opacity(0.5) : .clear)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .padding(.horizontal, VSpacing.xs)
        .contentShape(Rectangle())
    }

    private func recentRow(_ recent: CommandPaletteRecentItem, isSelected: Bool) -> some View {
        HStack(spacing: VSpacing.md) {
            VIconView(.messagesSquare, size: 13)
                .foregroundStyle(VColor.contentSecondary)
                .frame(width: 20, alignment: .center)

            Text(recent.title)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)

            Spacer()

            Text(relativeTime(recent.lastInteracted))
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(isSelected ? VColor.borderBase.opacity(0.5) : .clear)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .padding(.horizontal, VSpacing.xs)
        .contentShape(Rectangle())
    }

    private func conversationRow(_ conv: SearchResultConversation, isSelected: Bool) -> some View {
        HStack(spacing: VSpacing.md) {
            VIconView(.messagesSquare, size: 13)
                .foregroundStyle(VColor.contentSecondary)
                .frame(width: 20, alignment: .center)

            VStack(alignment: .leading, spacing: 2) {
                Text(conv.title ?? "Untitled")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)

                if !conv.excerpt.isEmpty {
                    Text(conv.excerpt)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .lineLimit(1)
                }
            }

            Spacer()

            Text(relativeTimestamp(conv.updatedAt))
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(isSelected ? VColor.borderBase.opacity(0.5) : .clear)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .padding(.horizontal, VSpacing.xs)
        .contentShape(Rectangle())
    }

    private func scheduleRow(_ schedule: SearchResultSchedule, isSelected: Bool) -> some View {
        HStack(spacing: VSpacing.md) {
            VIconView(.clock, size: 13)
                .foregroundStyle(VColor.contentSecondary)
                .frame(width: 20, alignment: .center)

            VStack(alignment: .leading, spacing: 2) {
                Text(schedule.name)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)

                Text(schedule.message)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineLimit(1)
            }

            Spacer()

            Text(schedule.enabled ? "Active" : "Paused")
                .font(VFont.labelDefault)
                .foregroundStyle(schedule.enabled ? VColor.systemPositiveStrong : VColor.contentTertiary)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(isSelected ? VColor.borderBase.opacity(0.5) : .clear)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .padding(.horizontal, VSpacing.xs)
        .contentShape(Rectangle())
    }

    private func contactRow(_ contact: SearchResultContact, isSelected: Bool) -> some View {
        HStack(spacing: VSpacing.md) {
            VIconView(.users, size: 13)
                .foregroundStyle(VColor.contentSecondary)
                .frame(width: 20, alignment: .center)

            VStack(alignment: .leading, spacing: 2) {
                Text(contact.displayName)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)

                if let notes = contact.notes, !notes.isEmpty {
                    Text(notes.components(separatedBy: .newlines).first ?? notes)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .lineLimit(1)
                }
            }

            Spacer()
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(isSelected ? VColor.borderBase.opacity(0.5) : .clear)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .padding(.horizontal, VSpacing.xs)
        .contentShape(Rectangle())
    }

    private var emptyState: some View {
        VStack(spacing: VSpacing.xs) {
            if viewModel.query.isEmpty {
                Text("Type to search...")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            } else {
                Text("No results found.")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
                Text("Try rephrasing your search.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
        .multilineTextAlignment(.center)
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
        case .conversation(let conv):
            onSelectConversation?(conv.id)
            onDismiss()
        case .schedule, .contact:
            // Non-navigable results — no action on Enter
            break
        }
    }

    private func relativeTime(_ date: Date) -> String {
        let interval = Date().timeIntervalSince(date)
        if interval < 60 { return "just now" }
        if interval < 3600 { return "\(Int(interval / 60))m ago" }
        if interval < 86400 { return "\(Int(interval / 3600))h ago" }
        return "\(Int(interval / 86400))d ago"
    }

    private func relativeTimestamp(_ epochMs: Double) -> String {
        let date = Date(timeIntervalSince1970: epochMs / 1000)
        return relativeTime(date)
    }
}
