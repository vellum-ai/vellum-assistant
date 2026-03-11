import SwiftUI
import VellumAssistantShared

/// Automation settings tab — reminders, scheduled tasks, and heartbeat monitoring.
@MainActor
struct SettingsAutomationTab: View {
    var daemonClient: DaemonClient?
    @Binding var showingReminders: Bool
    @Binding var showingScheduledTasks: Bool
    @Binding var showingHeartbeatConfig: Bool
    @Binding var showingHeartbeatRuns: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Reminders section — one-shot schedules shown as reminders
            if daemonClient != nil {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("Reminders")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        VStack(alignment: .leading, spacing: VSpacing.sm) {
                            Text("Manage Reminders")
                                .font(VFont.inputLabel)
                                .foregroundColor(VColor.textSecondary)
                            Text("View and manage one-shot reminders created by the assistant")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        VButton(label: "Manage", style: .secondary) {
                            showingReminders = true
                        }
                    }
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .vCard(background: VColor.surfaceSubtle)
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("Scheduled Tasks")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        VStack(alignment: .leading, spacing: VSpacing.sm) {
                            Text("Manage Scheduled Tasks")
                                .font(VFont.inputLabel)
                                .foregroundColor(VColor.textSecondary)
                            Text("View and manage recurring tasks (cron and RRULE schedules)")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        VButton(label: "Manage", style: .secondary) {
                            showingScheduledTasks = true
                        }
                    }
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .vCard(background: VColor.surfaceSubtle)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Heartbeat section (checklist + runs, minus configCard)
            HeartbeatAutomationSection(daemonClient: daemonClient, showingHeartbeatConfig: $showingHeartbeatConfig, showingHeartbeatRuns: $showingHeartbeatRuns)
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
    @Binding var showingHeartbeatRuns: Bool

    // -- Checklist state --
    @State private var checklistContent: String = ""
    @State private var isDefaultChecklist: Bool = true

    // -- Run now state --
    @State private var isRunning: Bool = false
    @State private var runError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            checklistCard
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
                if isRunning {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    VIconButton(label: "Run Now", icon: VIcon.play.rawValue, iconOnly: true, tooltip: "Run Now") {
                        triggerRun()
                    }
                }
                VIconButton(label: "History", icon: VIcon.history.rawValue, iconOnly: true, tooltip: "History") {
                    showingHeartbeatRuns = true
                }
                VIconButton(label: "Config", icon: VIcon.settings.rawValue, iconOnly: true, tooltip: "Config") {
                    showingHeartbeatConfig = true
                }
            }

            if let error = runError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
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
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Actions

    private func triggerRun() {
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

    // MARK: - Data Loading

    private func loadAll() {
        try? daemonClient?.sendHeartbeatChecklistRead()
    }

    private func setupCallbacks() {
        daemonClient?.onHeartbeatChecklistResponse = { response in
            Task { @MainActor in
                self.checklistContent = response.content
                self.isDefaultChecklist = response.isDefault
            }
        }
        daemonClient?.onHeartbeatRunNowResponse = { response in
            Task { @MainActor in
                self.isRunning = false
                if !response.success {
                    self.runError = response.error ?? "Run failed"
                }
            }
        }
    }

    private func clearCallbacks() {
        daemonClient?.onHeartbeatChecklistResponse = nil
        daemonClient?.onHeartbeatRunNowResponse = nil
    }
}
