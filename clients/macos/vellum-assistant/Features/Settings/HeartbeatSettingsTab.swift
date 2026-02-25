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
    @State private var useActiveHours: Bool = false

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
    @State private var isUpdatingFromServer: Bool = false

    private static let intervalOptions: [(label: String, ms: Double)] = [
        ("5 min", 300_000),
        ("15 min", 900_000),
        ("30 min", 1_800_000),
        ("1 hour", 3_600_000),
        ("2 hours", 7_200_000),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            configCard
            checklistCard
            runsCard
        }
        .onAppear { setupCallbacks(); loadAll() }
        .onDisappear { clearCallbacks() }
    }

    // MARK: - Configuration Card

    private var configCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Configuration")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            // Enable toggle
            HStack {
                Text("Enable Heartbeat")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
                Toggle("", isOn: $isEnabled)
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .onChange(of: isEnabled) { _, newValue in
                        guard !isUpdatingFromServer else { return }
                        try? daemonClient?.sendHeartbeatConfigSet(enabled: newValue)
                    }
            }

            if isEnabled {
                Divider().background(VColor.surfaceBorder)

                // Interval picker
                HStack {
                    Text("Check every")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    Picker("", selection: $intervalMs) {
                        ForEach(Self.intervalOptions, id: \.ms) { option in
                            Text(option.label).tag(option.ms)
                        }
                    }
                    .labelsHidden()
                    .fixedSize()
                    .onChange(of: intervalMs) { _, newValue in
                        guard !isUpdatingFromServer else { return }
                        try? daemonClient?.sendHeartbeatConfigSet(intervalMs: newValue)
                    }
                }

                Divider().background(VColor.surfaceBorder)

                // Active hours
                HStack {
                    Text("Active hours only")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    Toggle("", isOn: $useActiveHours)
                        .toggleStyle(.switch)
                        .labelsHidden()
                        .onChange(of: useActiveHours) { _, newValue in
                            guard !isUpdatingFromServer else { return }
                            if newValue {
                                let start = activeHoursStart ?? 8
                                let end = activeHoursEnd ?? 22
                                activeHoursStart = start
                                activeHoursEnd = end
                                try? daemonClient?.sendHeartbeatConfigSet(activeHoursStart: start, activeHoursEnd: end)
                            } else {
                                activeHoursStart = nil
                                activeHoursEnd = nil
                                // Send -1 sentinel to clear — Swift JSONEncoder omits nil optionals
                                try? daemonClient?.sendHeartbeatConfigSet(
                                    activeHoursStart: -1,
                                    activeHoursEnd: -1
                                )
                            }
                        }
                }

                if useActiveHours {
                    HStack {
                        Text("From")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                        Picker("", selection: Binding(
                            get: { Int(activeHoursStart ?? 8) },
                            set: { newVal in
                                activeHoursStart = Double(newVal)
                                try? daemonClient?.sendHeartbeatConfigSet(activeHoursStart: Double(newVal))
                            }
                        )) {
                            ForEach(0..<24, id: \.self) { hour in
                                Text(formatHour(hour)).tag(hour)
                            }
                        }
                        .labelsHidden()
                        .fixedSize()

                        Text("to")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                        Picker("", selection: Binding(
                            get: { Int(activeHoursEnd ?? 22) },
                            set: { newVal in
                                activeHoursEnd = Double(newVal)
                                try? daemonClient?.sendHeartbeatConfigSet(activeHoursEnd: Double(newVal))
                            }
                        )) {
                            ForEach(0..<24, id: \.self) { hour in
                                Text(formatHour(hour)).tag(hour)
                            }
                        }
                        .labelsHidden()
                        .fixedSize()
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

            Text("Items the heartbeat checks on each run (HEARTBEAT.md)")
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
                    Button {
                        withAnimation(VAnimation.fast) {
                            expandedRunId = expandedRunId == run.id ? nil : run.id
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 0) {
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

                            if expandedRunId == run.id {
                                Text(run.summary ?? "No summary available")
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
                    }
                    .buttonStyle(.plain)

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
                self.isUpdatingFromServer = true
                self.isEnabled = response.enabled
                self.intervalMs = response.intervalMs
                self.activeHoursStart = response.activeHoursStart
                self.activeHoursEnd = response.activeHoursEnd
                self.useActiveHours = response.activeHoursStart != nil && response.activeHoursEnd != nil
                self.nextRunAt = response.nextRunAt
                self.isLoading = false
                self.isUpdatingFromServer = false
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
