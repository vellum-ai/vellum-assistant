import SwiftUI
import VellumAssistantShared

/// macOS Task Queue side panel — lists work items with status badges,
/// run/cancel actions, preflight approval, and output viewing.
struct TaskQueuePanel: View {
    @ObservedObject var viewModel: TaskQueueViewModel
    var onClose: () -> Void

    var body: some View {
        VSidePanel(title: "Tasks", onClose: onClose, pinnedContent: {
            filterStrip
            Divider().background(VColor.surfaceBorder)
        }) {
            contentView
        }
        .sheet(isPresented: Binding(
            get: { viewModel.selectedOutputItem != nil },
            set: { if !$0 { viewModel.dismissOutput() } }
        )) {
            if let item = viewModel.selectedOutputItem {
                TaskOutputView(
                    itemTitle: item.title,
                    state: viewModel.outputState,
                    onDismiss: { viewModel.dismissOutput() }
                )
            }
        }
        .sheet(isPresented: Binding(
            get: { viewModel.preflightItem != nil },
            set: { if !$0 { viewModel.dismissPreflight() } }
        )) {
            if let item = viewModel.preflightItem {
                TaskPreflightView(
                    itemTitle: item.title,
                    state: viewModel.preflightState,
                    onApprove: { approvedTools in
                        viewModel.approveAndRun(id: item.id, approvedTools: approvedTools)
                    },
                    onDismiss: { viewModel.dismissPreflight() }
                )
            }
        }
        .alert("Error", isPresented: Binding(
            get: { viewModel.errorMessage != nil },
            set: { if !$0 { viewModel.errorMessage = nil } }
        )) {
            Button("OK") { viewModel.errorMessage = nil }
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }

    // MARK: - Filter Strip

    private var filterStrip: some View {
        HStack(spacing: VSpacing.sm) {
            ForEach(WorkItemStatusFilter.allCases, id: \.rawValue) { filter in
                Button {
                    viewModel.statusFilter = filter
                } label: {
                    Text(filter.rawValue)
                        .font(VFont.captionMedium)
                        .foregroundColor(viewModel.statusFilter == filter ? VColor.textPrimary : VColor.textMuted)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(
                            viewModel.statusFilter == filter
                                ? VColor.surfaceBorder.opacity(0.5)
                                : Color.clear
                        )
                        .cornerRadius(6)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Filter: \(filter.rawValue)")
                .accessibilityHint(viewModel.statusFilter == filter ? "Currently selected" : "Double-tap to filter by \(filter.rawValue.lowercased())")
            }
            Spacer()
            Button {
                viewModel.fetchItems()
            } label: {
                VIconView(.refreshCw, size: 12)
                    .foregroundColor(VColor.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Refresh tasks")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Content

    @ViewBuilder
    private var contentView: some View {
        if viewModel.isLoading {
            VStack(spacing: VSpacing.md) {
                Spacer()
                ProgressView()
                    .controlSize(.small)
                Text("Loading tasks…")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if viewModel.filteredItems.isEmpty {
            emptyState
        } else {
            taskList
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()
            VIconView(.clipboardList, size: 40)
                .foregroundColor(VColor.textMuted)
                .accessibilityHidden(true)
            Text("No Tasks")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)
            Text("Your one-shot tasks will appear here.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Task List

    private var taskList: some View {
        LazyVStack(spacing: 0) {
            ForEach(viewModel.filteredItems, id: \.id) { item in
                TaskQueueRow(
                    item: item,
                    hasOutput: viewModel.taskHasOutput(item),
                    runningIds: viewModel.runInFlightIds,
                    timeoutIds: viewModel.runTimeoutIds,
                    cancelInFlightIds: viewModel.cancelInFlightIds,
                    onViewOutput: { viewModel.fetchOutput(for: item) },
                    onRun: { viewModel.initiateRun(item: item) },
                    onCancel: { viewModel.cancelTask(id: item.id) },
                    onRemove: { viewModel.removeTask(id: item.id) },
                    onPriorityChange: { tier in viewModel.updatePriority(id: item.id, tier: tier) }
                )
                Divider().background(VColor.surfaceBorder).padding(.horizontal, VSpacing.md)
            }
        }
    }
}

// MARK: - Task Queue Row

/// A single task row in the macOS task queue panel.
private struct TaskQueueRow: View {
    let item: IPCWorkItemsListResponseItem
    let hasOutput: Bool
    let runningIds: Set<String>
    let timeoutIds: Set<String>
    let cancelInFlightIds: Set<String>
    let onViewOutput: () -> Void
    let onRun: () -> Void
    let onCancel: () -> Void
    let onRemove: () -> Void
    let onPriorityChange: (Double) -> Void

    private var status: WorkItemStatus { WorkItemStatus(rawStatus: item.status) }
    private var isRunning: Bool { runningIds.contains(item.id) || status == .running }
    private var isCancelling: Bool { cancelInFlightIds.contains(item.id) }
    private var isTimedOut: Bool { timeoutIds.contains(item.id) }
    private var isFailed: Bool { status == .failed || status == .cancelled }
    private var isCompleted: Bool { status == .done || status == .awaitingReview }
    private var isArchived: Bool { status == .archived }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            titleRow
            actionRow
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .contextMenu { contextMenuItems }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Task: \(item.title), status: \(TasksTableContract.statusStyle(for: status).label)")
    }

    // MARK: - Title Row

    private var titleRow: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            Text(item.title)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            statusBadge
        }
    }

    // MARK: - Status Badge

    private var statusBadge: some View {
        let style = TasksTableContract.statusStyle(for: status)
        return HStack(spacing: 4) {
            if isRunning {
                ProgressView()
                    .controlSize(.mini)
                    .scaleEffect(0.7)
                    .frame(width: 10, height: 10)
            } else {
                Circle()
                    .fill(statusBadgeColor)
                    .frame(width: 7, height: 7)
            }
            Text(style.label)
                .font(VFont.caption)
                .foregroundColor(statusBadgeColor)
        }
        .padding(.horizontal, VSpacing.xs)
        .padding(.vertical, 3)
        .background(statusBadgeColor.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }

    private var statusBadgeColor: Color {
        if isTimedOut { return VColor.warning }
        if isFailed { return VColor.error }
        if isRunning { return VColor.accent }
        if isCompleted { return VColor.success }
        return VColor.textSecondary
    }

    // MARK: - Action Row

    private var actionRow: some View {
        HStack(spacing: VSpacing.sm) {
            priorityBadge
            Spacer()
            actionButtons
        }
    }

    // MARK: - Priority Badge

    private var priorityBadge: some View {
        let style = TasksTableContract.priorityStyle(for: item.priorityTier)
        return Menu {
            ForEach(TasksTableContract.allPriorityTiers, id: \.tier) { option in
                Button {
                    onPriorityChange(option.tier)
                } label: {
                    Label {
                        Text(option.label)
                    } icon: {
                        VIconView(option.tier == item.priorityTier ? .circleCheck : .circle, size: 12)
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Circle()
                    .fill(style.color)
                    .frame(width: 7, height: 7)
                Text(style.label)
                    .font(VFont.caption)
                    .foregroundColor(style.color)
            }
            .padding(.horizontal, VSpacing.xs)
            .padding(.vertical, 3)
            .background(style.color.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .accessibilityLabel("Priority: \(style.label)")
    }

    // MARK: - Action Buttons

    @ViewBuilder
    private var actionButtons: some View {
        if isArchived {
            EmptyView()
        } else if isRunning {
            stopButton
        } else if isCompleted && hasOutput {
            resultButton
        } else {
            runButton
        }
    }

    private var stopButton: some View {
        Button(action: onCancel) {
            HStack(spacing: 4) {
                VIconView(.square, size: 10)
                Text(isCancelling ? "Stopping…" : "Stop")
                    .font(VFont.caption)
            }
            .foregroundColor(.white)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .background(VColor.error)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        }
        .buttonStyle(.plain)
        .disabled(isCancelling)
        .opacity(isCancelling ? 0.5 : 1.0)
        .accessibilityLabel(isCancelling ? "Stopping task" : "Stop task")
    }

    private var resultButton: some View {
        Button(action: onViewOutput) {
            HStack(spacing: 4) {
                VIconView(.fileText, size: 10)
                Text("Result")
                    .font(VFont.caption)
            }
            .foregroundColor(.white)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .background(VColor.accent)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("View task result")
    }

    @ViewBuilder
    private var runButton: some View {
        VStack(spacing: 2) {
            Button(action: onRun) {
                HStack(spacing: 4) {
                    VIconView(runButtonIcon, size: 10)
                    Text(runButtonLabel)
                        .font(VFont.caption)
                }
                .foregroundColor(.white)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)
                .background(runButtonColor)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(runButtonLabel)

            if isTimedOut {
                Text("No response")
                    .font(VFont.small)
                    .foregroundColor(VColor.warning)
            }
        }
    }

    private var runButtonLabel: String {
        if isTimedOut || isFailed { return "Retry" }
        if isCompleted { return "Rerun" }
        return "Run"
    }

    private var runButtonIcon: VIcon {
        (isFailed || isTimedOut || isCompleted) ? .refreshCw : .play
    }

    private var runButtonColor: Color {
        (isFailed || isTimedOut) ? VColor.warning : VColor.accent
    }

    // MARK: - Context Menu

    @ViewBuilder
    private var contextMenuItems: some View {
        if !isArchived {
            if isRunning {
                Button("Stop", action: onCancel)
            } else {
                Button("Run", action: onRun)
            }
            if isCompleted && hasOutput {
                Button("View Result", action: onViewOutput)
            }
            Divider()
        }
        Button("Remove", role: .destructive, action: onRemove)
    }
}

#Preview {
    ZStack {
        VColor.background.ignoresSafeArea()
        TaskQueuePanel(
            viewModel: TaskQueueViewModel(daemonClient: DaemonClient()),
            onClose: {}
        )
    }
    .frame(width: 400, height: 600)
}
