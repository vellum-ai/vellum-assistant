#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// iOS Tasks tab — lets users view, run, and monitor one-shot tasks.
struct TasksView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @StateObject private var viewModel: TasksViewModel

    init(daemonClient: DaemonClient) {
        _viewModel = StateObject(wrappedValue: TasksViewModel(daemonClient: daemonClient))
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Tasks")
                .toolbar {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button {
                            viewModel.fetchItems()
                        } label: {
                            VIconView(.refreshCw, size: 14)
                        }
                        .accessibilityLabel("Refresh tasks")
                    }
                }
                .refreshable {
                    await viewModel.fetchItemsAsync()
                }
        }
        .sheet(isPresented: Binding(
            get: { viewModel.selectedOutputItem != nil },
            set: { if !$0 { viewModel.dismissOutput() } }
        )) {
            if let item = viewModel.selectedOutputItem {
                IOSTaskOutputDetailView(
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
                IOSTaskPermissionPreflightView(
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

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading {
            VStack(spacing: VSpacing.md) {
                ProgressView()
                Text("Loading tasks…")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if viewModel.items.isEmpty {
            emptyState
        } else {
            taskList
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: VSpacing.lg) {
            VIconView(.clipboardList, size: 48)
                .foregroundColor(VColor.textMuted)
                .accessibilityHidden(true)
            Text("No Tasks")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)
            Text("Your one-shot tasks will appear here.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Task List

    private var taskList: some View {
        List {
            ForEach(viewModel.items, id: \.id) { item in
                TaskRow(
                    item: item,
                    hasOutput: viewModel.taskHasOutput(item),
                    runningIds: viewModel.runInFlightIds,
                    timeoutIds: viewModel.runTimeoutIds,
                    cancelInFlightIds: viewModel.cancelInFlightIds,
                    onViewOutput: { viewModel.fetchOutput(for: item) },
                    onRun: { viewModel.initiateRun(item: item) },
                    onCancel: { viewModel.cancelTask(id: item.id) },
                    onPriorityChange: { tier in viewModel.updatePriority(id: item.id, tier: tier) }
                )
                .listRowInsets(EdgeInsets(top: VSpacing.xs, leading: VSpacing.md, bottom: VSpacing.xs, trailing: VSpacing.md))
            }
            .onDelete { indexSet in
                // Resolve all IDs before any removal so index shifts
                // from earlier removeTask calls don't corrupt later lookups.
                let ids = indexSet.map { viewModel.items[$0].id }
                for id in ids {
                    viewModel.removeTask(id: id)
                }
            }
        }
        .listStyle(.plain)
    }
}

// MARK: - Task Row

/// A single task row in the iOS task list.
private struct TaskRow: View {
    let item: IPCWorkItemsListResponseItem
    let hasOutput: Bool
    let runningIds: Set<String>
    let timeoutIds: Set<String>
    let cancelInFlightIds: Set<String>
    let onViewOutput: () -> Void
    let onRun: () -> Void
    let onCancel: () -> Void
    let onPriorityChange: (Double) -> Void

    private var status: WorkItemStatus { WorkItemStatus(rawStatus: item.status) }
    private var isRunning: Bool { runningIds.contains(item.id) || status == .running }
    private var isCancelling: Bool { cancelInFlightIds.contains(item.id) }
    private var isTimedOut: Bool { timeoutIds.contains(item.id) }
    private var isFailed: Bool { status == .failed || status == .cancelled }
    private var isCompleted: Bool { status == .done || status == .awaitingReview }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Title and status badge
            HStack(alignment: .top, spacing: VSpacing.sm) {
                Text(item.title)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                statusBadge
            }

            // Priority and action buttons
            HStack(spacing: VSpacing.sm) {
                priorityBadge
                Spacer()
                actionButtons
            }
        }
        .padding(.vertical, VSpacing.xs)
    }

    // MARK: - Status Badge

    private var statusBadge: some View {
        let style = TasksTableContract.statusStyle(for: status)
        return HStack(spacing: 4) {
            if isRunning {
                ProgressView()
                    .scaleEffect(0.65)
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
        .accessibilityLabel("Priority: \(style.label)")
    }

    // MARK: - Action Buttons

    // Archived tasks show no actions — they can't be run or have output fetched.
    private var isArchived: Bool { status == .archived }

    @ViewBuilder
    private var actionButtons: some View {
        if isArchived {
            EmptyView()
        } else if isRunning {
            Button(action: onCancel) {
                HStack(spacing: 4) {
                    VIconView(.square, size: 11)
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
        } else if isCompleted && hasOutput {
            Button(action: onViewOutput) {
                HStack(spacing: 4) {
                    VIconView(.fileText, size: 11)
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
        } else {
            VStack(spacing: 2) {
                Button(action: onRun) {
                    HStack(spacing: 4) {
                        VIconView(runButtonIcon, size: 11)
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
}

// MARK: - Disconnected Wrapper

/// Shown when the app has no daemon connection — tasks require Connected mode.
struct TasksDisconnectedView: View {
    var onConnectTapped: (() -> Void)?

    var body: some View {
        NavigationStack {
            VStack(spacing: VSpacing.lg) {
                VIconView(.clipboardList, size: 48)
                    .foregroundColor(VColor.textMuted)
                    .accessibilityHidden(true)
                Text("Tasks Require Connection")
                    .font(VFont.title)
                    .foregroundColor(VColor.textPrimary)
                Text("Connect to your Assistant to create and run one-shot tasks.")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, VSpacing.xl)
                if onConnectTapped != nil {
                    Button {
                        onConnectTapped?()
                    } label: {
                        Text("Go to Settings")
                    }
                    .buttonStyle(.bordered)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("Tasks")
        }
    }
}

// MARK: - Tab Entry Point

/// The tab-level Tasks entry point. Switches between connected and disconnected
/// states so TasksView only mounts when a live DaemonClient is available.
struct TasksTabView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    var onConnectTapped: (() -> Void)?

    var body: some View {
        if let daemon = clientProvider.client as? DaemonClient, clientProvider.isConnected {
            TasksView(daemonClient: daemon)
                .environmentObject(clientProvider)
        } else {
            TasksDisconnectedView(onConnectTapped: onConnectTapped)
        }
    }
}

#Preview {
    TasksDisconnectedView()
        .environmentObject(ClientProvider(client: DaemonClient(config: .default)))
}

#endif
