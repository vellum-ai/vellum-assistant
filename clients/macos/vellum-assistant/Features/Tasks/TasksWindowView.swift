import SwiftUI
import VellumAssistantShared

/// Standalone window view that displays the task queue.
struct TasksWindowView: View {
    @StateObject private var viewModel: TasksWindowViewModel

    init(daemonClient: DaemonClient) {
        _viewModel = StateObject(wrappedValue: TasksWindowViewModel(daemonClient: daemonClient))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Tasks")
                    .font(VFont.display)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                Text("\(viewModel.items.count)")
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
            if viewModel.isLoading {
                VStack {
                    Spacer()
                    ProgressView()
                        .controlSize(.small)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = viewModel.errorMessage {
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
                        viewModel.fetchItems()
                    }
                    .font(VFont.caption)
                    Spacer()
                }
                .frame(maxWidth: .infinity)
                .padding(VSpacing.lg)
            } else if viewModel.items.isEmpty {
                VEmptyState(
                    title: "No tasks",
                    subtitle: "Your tasks will appear here",
                    icon: "list.bullet.clipboard"
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: VSpacing.xs) {
                        ForEach(viewModel.items, id: \.id) { item in
                            TasksWindowRow(
                                item: item,
                                hasOutput: viewModel.taskHasOutput(item),
                                runningIds: viewModel.runInFlightIds,
                                timeoutIds: viewModel.runTimeoutIds,
                                onTap: { viewModel.fetchOutput(for: item) },
                                onRun: { viewModel.runTask(id: item.id) },
                                onComplete: { viewModel.completeTask(id: item.id) },
                                onRemove: { viewModel.removeTask(id: item.id) },
                                onPriorityChange: { newTier in
                                    viewModel.updatePriority(id: item.id, tier: newTier)
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
        .sheet(isPresented: Binding(
            get: { viewModel.selectedOutputItem != nil },
            set: { if !$0 { viewModel.dismissOutput() } }
        )) {
            if let item = viewModel.selectedOutputItem {
                TaskOutputDetailView(
                    itemTitle: item.title,
                    state: viewModel.outputState,
                    onDismiss: { viewModel.dismissOutput() }
                )
            }
        }
    }
}

// MARK: - Row View

/// Row view using explicit columns aligned to `TasksTableContract`.
private struct TasksWindowRow: View {
    let item: IPCWorkItemsListResponseItem
    let hasOutput: Bool
    let runningIds: Set<String>
    let timeoutIds: Set<String>
    let onTap: () -> Void
    let onRun: () -> Void
    let onComplete: () -> Void
    let onRemove: () -> Void
    let onPriorityChange: (Double) -> Void
    @State private var isHovered = false
    @State private var isTitleHovered = false

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

            // Actions column — fixed width; sits above the row background
            // in the hit-test stack so button clicks are never intercepted.
            actionsColumn
                .frame(width: TasksTableContract.actionsWidth)
                .contentShape(Rectangle())
                .allowsHitTesting(true)
        }
        .frame(minHeight: 36)
        .padding(.vertical, VSpacing.sm)
        .padding(.horizontal, VSpacing.md)
        .contentShape(Rectangle())
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
        Group {
            if hasOutput {
                Text(item.title)
                    .font(VFont.body)
                    .foregroundColor(isTitleHovered ? VColor.accent : VColor.textPrimary)
                    .underline(isTitleHovered, color: VColor.accent)
                    .lineLimit(TasksTableContract.titleLineLimit)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .onHover { hovering in isTitleHovered = hovering }
                    .onTapGesture(perform: onTap)
                    .accessibilityLabel("View output for \(item.title)")
                    .accessibilityAddTraits(.isButton)
            } else {
                Text(item.title)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(TasksTableContract.titleLineLimit)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
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
            .padding(.horizontal, VSpacing.xs)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(isHovered ? VColor.surfaceBorder.opacity(0.5) : Color.clear)
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .accessibilityLabel("Priority \(style.label)")
        .accessibilityHint("Double-click to change priority")
    }

    // MARK: - Status Column

    private var statusColumn: some View {
        let status = WorkItemStatus(rawStatus: item.status)
        let style = TasksTableContract.statusStyle(for: status)
        return HStack(spacing: VSpacing.xs) {
            if status == .running {
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
        .accessibilityLabel("Status \(style.label)")
    }

    // MARK: - Actions Column

    private var actionsColumn: some View {
        let status = WorkItemStatus(rawStatus: item.status)
        let isRunning = runningIds.contains(item.id)
        let isTimedOut = timeoutIds.contains(item.id)
        let isFailed = status == .failed
        let runEnabled = !isRunning
        let showRun = status == .queued || isFailed || isTimedOut
        let buttonColor = (isFailed || isTimedOut) ? VColor.warning : VColor.accent
        let buttonLabel: String = {
            if isRunning { return "Starting..." }
            if isTimedOut || isFailed { return "Retry" }
            return "Run"
        }()
        let buttonIcon = (isFailed || isTimedOut) ? "arrow.clockwise" : "play.fill"
        return HStack(spacing: VSpacing.xs) {
            if showRun {
                VStack(alignment: .center, spacing: 2) {
                    Button(action: onRun) {
                        HStack(spacing: VSpacing.xs) {
                            Image(systemName: buttonIcon)
                                .font(.system(size: 10))
                            Text(buttonLabel)
                                .font(VFont.caption)
                        }
                        .foregroundColor(.white)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(buttonColor)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!runEnabled)
                    .opacity(runEnabled ? 1.0 : 0.4)
                    .accessibilityLabel(isRunning ? "Task is starting" : ((isFailed || isTimedOut) ? "Retry task" : "Run task"))
                    .accessibilityHint(isRunning ? "Task is already starting" : (isTimedOut ? "No response received, tap to retry" : (isFailed ? "Retry running this failed task" : "")))

                    if isTimedOut {
                        Text("No response")
                            .font(VFont.small)
                            .foregroundColor(VColor.warning)
                    }
                }
            }

            if status == .awaitingReview {
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
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Mark task as reviewed")
            }

            if isHovered {
                Button(action: onRemove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(VColor.textMuted)
                        .frame(width: 20, height: 20)
                        .background(VColor.surfaceBorder.opacity(0.5))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove task")
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
