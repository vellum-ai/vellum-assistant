import SwiftUI
import VellumAssistantShared

/// Standalone window view that displays the task queue.
struct TasksWindowView: View {
    @ObservedObject var daemonClient: DaemonClient

    @State private var items: [IPCWorkItemsListResponseItem] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Tasks")
                    .font(VFont.display)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                Text("\(items.count)")
                    .font(VFont.monoSmall)
                    .foregroundColor(VColor.textMuted)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
                    .background(VColor.surface)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.top, VSpacing.lg)
            .padding(.bottom, VSpacing.sm)

            Divider()
                .background(VColor.surfaceBorder)

            // Column headers — fixed above the scrollable list
            HStack(alignment: .center, spacing: 0) {
                Text("Task")
                    .frame(maxWidth: .infinity, alignment: .leading)

                Text("Priority")
                    .frame(width: TasksTableContract.priorityWidth)

                Text("Status")
                    .frame(width: TasksTableContract.statusWidth)

                Text("Actions")
                    .frame(width: TasksTableContract.actionsWidth)
            }
            .font(VFont.captionMedium)
            .foregroundColor(VColor.textMuted)
            .padding(.vertical, VSpacing.sm)
            .padding(.horizontal, VSpacing.lg)
            // Inner horizontal padding matches row padding so labels sit
            // directly above their respective columns.
            .padding(.horizontal, VSpacing.md)

            Rectangle()
                .fill(VColor.surfaceBorder)
                .frame(height: 1)

            // Content
            if isLoading {
                VStack {
                    Spacer()
                    ProgressView()
                        .controlSize(.small)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = errorMessage {
                VStack(spacing: VSpacing.md) {
                    Spacer()
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 24))
                        .foregroundColor(VColor.warning)
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .multilineTextAlignment(.center)
                    Button("Retry") {
                        fetchWorkItems()
                    }
                    .font(VFont.caption)
                    Spacer()
                }
                .frame(maxWidth: .infinity)
                .padding(VSpacing.lg)
            } else if items.isEmpty {
                VEmptyState(
                    title: "No tasks",
                    subtitle: "Your tasks will appear here",
                    icon: "list.bullet.clipboard"
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: VSpacing.xs) {
                        ForEach(items, id: \.id) { item in
                            TasksWindowRow(
                                item: item,
                                onRun: { runTask(id: item.id) },
                                onComplete: { completeTask(id: item.id) },
                                onPriorityChange: { newTier in
                                    updatePriority(id: item.id, tier: newTier)
                                }
                            )
                        }
                    }
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.sm)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(VColor.background)
        .onAppear {
            fetchWorkItems()
            listenForStatusChanges()
        }
    }

    // MARK: - Data Fetching

    private func fetchWorkItems() {
        isLoading = true
        errorMessage = nil

        daemonClient.onWorkItemsListResponse = { response in
            self.items = response.items
            self.isLoading = false
        }

        do {
            try daemonClient.sendWorkItemsList()
        } catch {
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }

    private func listenForStatusChanges() {
        daemonClient.onWorkItemStatusChanged = { _ in
            do {
                try daemonClient.sendWorkItemsList()
            } catch {
                // Silently ignore; the list will refresh on next status change
            }
        }
    }

    // MARK: - Actions

    private func runTask(id: String) {
        do {
            try daemonClient.sendWorkItemRunTask(id: id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func completeTask(id: String) {
        do {
            try daemonClient.sendWorkItemComplete(id: id)
            items.removeAll { $0.id == id }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func updatePriority(id: String, tier: Double) {
        do {
            try daemonClient.sendWorkItemUpdate(id: id, priorityTier: tier)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Row View

/// Row view using explicit columns aligned to `TasksTableContract`.
private struct TasksWindowRow: View {
    let item: IPCWorkItemsListResponseItem
    let onRun: () -> Void
    let onComplete: () -> Void
    let onPriorityChange: (Double) -> Void
    @State private var isHovered = false

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            // Task column — flexible width
            taskColumn

            // Priority column — fixed width
            priorityColumn
                .frame(width: TasksTableContract.priorityWidth)

            // Status column — fixed width
            statusColumn
                .frame(width: TasksTableContract.statusWidth)

            // Actions column — fixed width
            actionsColumn
                .frame(width: TasksTableContract.actionsWidth)
        }
        .padding(.vertical, VSpacing.sm)
        .padding(.horizontal, VSpacing.md)
        .background(isHovered ? VColor.surface.opacity(0.8) : VColor.surface.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
        )
        .onHover { hovering in
            isHovered = hovering
        }
    }

    // MARK: - Task Column

    private var taskColumn: some View {
        Text(item.title)
            .font(VFont.body)
            .foregroundColor(VColor.textPrimary)
            .lineLimit(TasksTableContract.titleLineLimit)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Priority Column

    private var priorityColumn: some View {
        let style = TasksTableContract.priorityStyle(for: item.priorityTier)
        return Menu {
            ForEach(TasksTableContract.allPriorityTiers, id: \.tier) { option in
                Button {
                    onPriorityChange(option.tier)
                } label: {
                    Label {
                        Text(option.label)
                    } icon: {
                        Image(systemName: option.tier == item.priorityTier ? "checkmark.circle.fill" : "circle.fill")
                    }
                }
            }
        } label: {
            HStack(spacing: VSpacing.xs) {
                Circle()
                    .fill(style.color)
                    .frame(width: 8, height: 8)
                Text(style.label)
                    .font(VFont.caption)
                    .foregroundColor(style.color)
            }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .accessibilityLabel("Priority \(style.label)")
    }

    // MARK: - Status Column

    private var statusColumn: some View {
        let style = TasksTableContract.statusStyle(for: item.status)
        let showSpinner = item.status == "running"
        return HStack(spacing: VSpacing.xs) {
            if showSpinner {
                ProgressView()
                    .controlSize(.mini)
            }
            Text(style.label)
                .font(VFont.caption)
                .foregroundColor(style.color)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, 2)
        .background(style.color.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }

    // MARK: - Actions Column

    private var actionsColumn: some View {
        HStack(spacing: VSpacing.xs) {
            if item.status == "queued" {
                Button(action: onRun) {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "play.fill")
                            .font(.system(size: 10))
                        Text("Run")
                            .font(VFont.caption)
                    }
                    .foregroundColor(VColor.accent)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
                    .background(VColor.accent.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
                .buttonStyle(.plain)
            }

            if item.status == "awaiting_review" {
                Button(action: onComplete) {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "checkmark")
                            .font(.system(size: 10))
                        Text("Reviewed")
                            .font(VFont.caption)
                    }
                    .foregroundColor(VColor.success)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
                    .background(VColor.success.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - Preview

#if DEBUG
struct TasksWindowViewPreview: PreviewProvider {
    static var previews: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            TasksWindowView(daemonClient: DaemonClient())
                .frame(width: 420, height: 550)
        }
    }
}
#endif
