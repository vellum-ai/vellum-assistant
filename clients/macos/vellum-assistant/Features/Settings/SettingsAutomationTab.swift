import SwiftUI
import VellumAssistantShared

/// Automation settings tab — reminders, scheduled tasks, and heartbeat monitoring.
@MainActor
struct SettingsAutomationTab: View {
    var daemonClient: DaemonClient?
    @Binding var showingReminders: Bool
    @Binding var showingScheduledTasks: Bool
    @Binding var showingHeartbeatConfig: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            // Reminders section (from old Schedules tab)
            if daemonClient != nil {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("Reminders")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Manage Reminders")
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            Text("View and manage one-shot reminders created by the assistant")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        VButton(label: "Manage...", style: .secondary, size: .large) {
                            showingReminders = true
                        }
                    }
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .vCard(background: VColor.surfaceSubtle)

                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("Scheduled Tasks")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Manage Scheduled Tasks")
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            Text("View and manage recurring tasks (cron and RRULE schedules)")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        VButton(label: "Manage...", style: .secondary, size: .large) {
                            showingScheduledTasks = true
                        }
                    }
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .vCard(background: VColor.surfaceSubtle)
            }

            // Heartbeat section (checklist + runs, minus configCard)
            HeartbeatAutomationSection(daemonClient: daemonClient, showingHeartbeatConfig: $showingHeartbeatConfig)
        }
    }
}

// MARK: - Heartbeat Automation Section

/// Heartbeat monitoring section for the Automation tab.
/// Shows the checklist and recent runs (excludes the configuration card
/// which is managed via conversation with the assistant).
@MainActor
struct HeartbeatAutomationSection: View {
    var daemonClient: DaemonClient?
    @Binding var showingHeartbeatConfig: Bool

    // -- Checklist state --
    @State private var checklistContent: String = ""
    @State private var isDefaultChecklist: Bool = true

    // -- Runs state --
    @State private var runs: [IPCHeartbeatRunsListResponseRun] = []
    @State private var isRunning: Bool = false
    @State private var runError: String?

    // -- Expansion state --
    @State private var expandedRunId: String?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            checklistCard
            runsCard
        }
        .onAppear { setupCallbacks(); loadAll() }
        .onDisappear { clearCallbacks() }
    }

    // MARK: - Checklist Card

    private var checklistCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack {
                Text("Heartbeat Checklist")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                if isDefaultChecklist {
                    Text("Using default")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                VIconButton(label: "Config", icon: "gearshape", iconOnly: true) {
                    showingHeartbeatConfig = true
                }
            }

            Text("Items the heartbeat checks on each run")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            Text(checklistContent)
                .font(VFont.mono)
                .foregroundColor(VColor.textSecondary)
                .padding(VSpacing.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )

            Text("Ask the assistant to update HEARTBEAT.md to change this checklist.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Recent Runs Card

    private var runsCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack {
                Text("Heartbeat Runs")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                if isRunning {
                    ProgressView()
                        .controlSize(.small)
                    Text("Running...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                } else {
                    VButton(label: "Run Now", style: .primary, size: .large) {
                        isRunning = true
                        runError = nil
                        guard let client = daemonClient else {
                            isRunning = false
                            runError = "Daemon not available"
                            return
                        }
                        do {
                            try client.sendHeartbeatRunNow()
                        } catch {
                            isRunning = false
                            runError = "Failed to send run request"
                        }
                    }
                }
            }

            if let error = runError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }

            if runs.isEmpty {
                Text("No heartbeat runs yet")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, VSpacing.lg)
            } else {
                ForEach(runs, id: \.id) { run in
                    VStack(alignment: .leading, spacing: 0) {
                        Button {
                            withAnimation(VAnimation.fast) {
                                expandedRunId = expandedRunId == run.id ? nil : run.id
                            }
                        } label: {
                            HStack(spacing: VSpacing.md) {
                                resultBadge(run.result)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(run.title)
                                        .font(VFont.body)
                                        .foregroundColor(VColor.textPrimary)
                                        .lineLimit(1)
                                    Text(formatTimestamp(run.createdAt))
                                        .font(VFont.caption)
                                        .foregroundColor(VColor.textMuted)
                                }
                                Spacer()
                                Image(systemName: expandedRunId == run.id ? "chevron.down" : "chevron.right")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundColor(VColor.textMuted)
                            }
                            .padding(VSpacing.sm)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        if expandedRunId == run.id {
                            Text(run.summary?.isEmpty == false ? run.summary! : "No summary available")
                                .font(VFont.mono)
                                .foregroundColor(VColor.textSecondary)
                                .textSelection(.enabled)
                                .padding(VSpacing.sm)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(VColor.surface)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                                .overlay(
                                    RoundedRectangle(cornerRadius: VRadius.md)
                                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                                )
                                .padding(.horizontal, VSpacing.sm)
                                .padding(.bottom, VSpacing.sm)
                        }
                    }

                    if run.id != runs.last?.id {
                        Divider().background(VColor.surfaceBorder)
                    }
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Helpers

    private func resultBadge(_ result: String) -> some View {
        Group {
            switch result {
            case "ok":
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                    Text("OK")
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.success)
                }
            case "alert":
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(VColor.warning)
                    Text("ALERT")
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.warning)
                }
            default:
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "questionmark.circle")
                        .foregroundColor(VColor.textMuted)
                    Text("--")
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.textMuted)
                }
            }
        }
        .frame(width: 70, alignment: .leading)
    }

    private func formatTimestamp(_ ms: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000.0)
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    // MARK: - Data Loading

    private func loadAll() {
        try? daemonClient?.sendHeartbeatChecklistRead()
        try? daemonClient?.sendHeartbeatRunsList(limit: 20)
    }

    private func setupCallbacks() {
        daemonClient?.onHeartbeatChecklistResponse = { response in
            Task { @MainActor in
                self.checklistContent = response.content
                self.isDefaultChecklist = response.isDefault
            }
        }
        daemonClient?.onHeartbeatRunsListResponse = { response in
            Task { @MainActor in
                self.runs = response.runs
            }
        }
        daemonClient?.onHeartbeatRunNowResponse = { response in
            Task { @MainActor in
                self.isRunning = false
                if !response.success {
                    self.runError = response.error ?? "Run failed"
                } else {
                    // Refresh the runs list after a successful run
                    try? self.daemonClient?.sendHeartbeatRunsList(limit: 20)
                }
            }
        }
    }

    private func clearCallbacks() {
        daemonClient?.onHeartbeatChecklistResponse = nil
        daemonClient?.onHeartbeatRunsListResponse = nil
        daemonClient?.onHeartbeatRunNowResponse = nil
    }
}
