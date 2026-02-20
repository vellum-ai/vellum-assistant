import SwiftUI
import VellumAssistantShared

/// Standalone window view that displays the task queue.
struct TasksWindowView: View {
    @StateObject private var viewModel: TasksWindowViewModel

    init(daemonClient: DaemonClient, onOpenInChat: ((String, String, String) -> Void)? = nil) {
        _viewModel = StateObject(wrappedValue: TasksWindowViewModel(daemonClient: daemonClient, onOpenInChat: onOpenInChat))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Column headers — fixed above the scrollable list
            HStack(alignment: .center, spacing: 0) {
                Text("Task Description")
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
            .padding(.top, VSpacing.lg)
            .padding(.bottom, VSpacing.sm)
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
                                cancelInFlightIds: viewModel.cancelInFlightIds,
                                onTap: { viewModel.fetchOutput(for: item) },
                                onRun: { viewModel.initiateRun(item: item) },
                                onCancel: { viewModel.cancelTask(id: item.id) },
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
                    onDismiss: { viewModel.dismissOutput() },
                    onOpenInChat: viewModel.canOpenInChat ? {
                        viewModel.openInChat()
                    } : nil
                )
            }
        }
        .sheet(isPresented: Binding(
            get: { viewModel.preflightItem != nil },
            set: { if !$0 { viewModel.dismissPreflight() } }
        )) {
            if let item = viewModel.preflightItem {
                TaskPermissionPreflightView(
                    itemTitle: item.title,
                    state: viewModel.preflightState,
                    onApprove: { approvedTools in
                        viewModel.approveAndRun(id: item.id, approvedTools: approvedTools)
                    },
                    onDismiss: { viewModel.dismissPreflight() }
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
    let cancelInFlightIds: Set<String>
    let onTap: () -> Void
    let onRun: () -> Void
    let onCancel: () -> Void
    let onRemove: () -> Void
    let onPriorityChange: (Double) -> Void
    @State private var isHovered = false
    @State private var isStatusHovered = false

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
        return VStack(spacing: VSpacing.xs) {
            HStack(spacing: VSpacing.xs) {
                if status == .running {
                    ProgressView()
                        .controlSize(.mini)
                }
                Circle()
                    .fill(style.color)
                    .frame(width: 6, height: 6)
                Text(style.label)
                    .font(VFont.caption)
                    .foregroundColor(style.color)
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, 2)
            .background(style.color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))

            if hasOutput {
                Text("See result")
                    .font(VFont.small)
                    .foregroundColor(VColor.accent)
                    .underline()
                    .onHover { hovering in isStatusHovered = hovering }
                    .opacity(isStatusHovered ? 0.7 : 1.0)
                    .onTapGesture { onTap() }
                    .accessibilityLabel("View task output")
                    .accessibilityAddTraits(.isButton)
            }
        }
    }

    // MARK: - Actions Column

    private var actionsColumn: some View {
        let status = WorkItemStatus(rawStatus: item.status)
        let isRunning = runningIds.contains(item.id) || status == .running
        let isCancelling = cancelInFlightIds.contains(item.id)
        let isTimedOut = timeoutIds.contains(item.id)
        let isFailed = status == .failed || status == .cancelled
        let isRerun = status == .done || status == .awaitingReview
        let showRun = status != .archived && !isRunning
        let runEnabled = !isRunning
        let buttonColor = (isFailed || isTimedOut) ? VColor.warning : VColor.accent
        let buttonLabel: String = {
            if isRunning { return "Running..." }
            if isTimedOut || isFailed { return "Retry" }
            if isRerun { return "Rerun" }
            return "Run"
        }()
        let buttonIcon = (isFailed || isTimedOut || isRerun) ? "arrow.clockwise" : "play.fill"
        return HStack(spacing: VSpacing.xs) {
            if isRunning {
                Button(action: onCancel) {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 10))
                        Text(isCancelling ? "Stopping..." : "Stop")
                            .font(VFont.caption)
                    }
                    .foregroundColor(.white)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
                    .background(VColor.error)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isCancelling)
                .opacity(isCancelling ? 0.4 : 1.0)
                .accessibilityLabel(isCancelling ? "Stopping task" : "Stop task")
                .accessibilityHint("Cancel the running task")
            } else if showRun {
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
                    .accessibilityLabel((isFailed || isTimedOut) ? "Retry task" : (isRerun ? "Rerun task" : "Run task"))
                    .accessibilityHint(isTimedOut ? "No response received, tap to retry" : (isFailed ? "Retry running this failed task" : ""))

                    if isTimedOut {
                        Text("No response")
                            .font(VFont.small)
                            .foregroundColor(VColor.warning)
                    }
                }
            }

            if isHovered && !isRunning {
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
