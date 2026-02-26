import SwiftUI
import VellumAssistantShared

// MARK: - Heartbeat Settings Tab

@MainActor
struct HeartbeatSettingsTab: View {
    var daemonClient: DaemonClient?

    // -- Config state --
    @State private var isEnabled: Bool = false
    @State private var intervalMs: Double = 3_600_000
    @State private var activeHoursStart: Double? = nil
    @State private var activeHoursEnd: Double? = nil
    @State private var nextRunAt: Int? = nil

    // -- Checklist state --
    @State private var checklistContent: String = ""
    @State private var isDefaultChecklist: Bool = true

    // -- Runs state --
    @State private var runs: [IPCHeartbeatRunsListResponseRun] = []
    @State private var isRunning: Bool = false
    @State private var runError: String?

    // -- Expansion state --
    @State private var expandedRunId: String?

    // -- Loading --
    @State private var isLoading: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            configCard
            checklistCard
            runsCard
        }
        .onAppear { setupCallbacks(); loadAll() }
        .onDisappear { clearCallbacks() }
    }

    // MARK: - Configuration Card (read-only)

    private var configCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Configuration")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            // Status
            HStack {
                Text("Status")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
                Text(isEnabled ? "Enabled" : "Disabled")
                    .font(VFont.bodyMedium)
                    .foregroundColor(isEnabled ? VColor.success : VColor.textMuted)
            }

            if isEnabled {
                Divider().background(VColor.surfaceBorder)

                // Interval
                HStack {
                    Text("Check every")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    Text(formatInterval(intervalMs))
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textPrimary)
                }

                // Active hours
                if let start = activeHoursStart, let end = activeHoursEnd {
                    Divider().background(VColor.surfaceBorder)
                    HStack {
                        Text("Active hours")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Spacer()
                        Text("\(formatHour(Int(start))) – \(formatHour(Int(end)))")
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.textPrimary)
                    }
                }

                // Next run status
                if let nextRun = nextRunAt, nextRun > 0 {
                    Divider().background(VColor.surfaceBorder)
                    HStack(spacing: VSpacing.sm) {
                        Image(systemName: "clock")
                            .font(.system(size: 12))
                            .foregroundColor(VColor.textMuted)
                        Text("Next run ~\(formatTimestamp(nextRun))")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                }
            }

            Divider().background(VColor.surfaceBorder)

            Text("Ask the assistant to change heartbeat settings.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Checklist Card

    private var checklistCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack {
                Text("Checklist")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                if isDefaultChecklist {
                    Text("Using default")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
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
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Recent Runs Card

    private var runsCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack {
                Text("Recent Runs")
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
                    VButton(label: "Run Now", style: .primary) {
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

    private func formatInterval(_ ms: Double) -> String {
        let minutes = Int(ms / 60_000)
        if minutes < 60 {
            return "\(minutes) min"
        }
        let hours = minutes / 60
        let remainingMinutes = minutes % 60
        if remainingMinutes == 0 {
            return hours == 1 ? "1 hour" : "\(hours) hours"
        }
        return "\(hours)h \(remainingMinutes)m"
    }

    private func formatHour(_ hour: Int) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "h a"
        let calendar = Calendar.current
        let date = calendar.date(from: DateComponents(hour: hour)) ?? Date()
        return formatter.string(from: date)
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
        try? daemonClient?.sendHeartbeatConfigGet()
        try? daemonClient?.sendHeartbeatChecklistRead()
        try? daemonClient?.sendHeartbeatRunsList(limit: 20)
    }

    private func setupCallbacks() {
        daemonClient?.onHeartbeatConfigResponse = { response in
            Task { @MainActor in
                self.isEnabled = response.enabled
                self.intervalMs = response.intervalMs
                self.activeHoursStart = response.activeHoursStart
                self.activeHoursEnd = response.activeHoursEnd
                self.nextRunAt = response.nextRunAt
                self.isLoading = false
            }
        }
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
        daemonClient?.onHeartbeatConfigResponse = nil
        daemonClient?.onHeartbeatChecklistResponse = nil
        daemonClient?.onHeartbeatRunsListResponse = nil
        daemonClient?.onHeartbeatRunNowResponse = nil
    }
}
