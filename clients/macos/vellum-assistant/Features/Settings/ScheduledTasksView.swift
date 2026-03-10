import SwiftUI
import VellumAssistantShared

struct ScheduledTasksView: View {
    let daemonClient: DaemonClient
    @Environment(\.dismiss) var dismiss

    @State private var schedules: [ScheduleItem] = []
    @State private var isLoading = true
    @State private var errorMessage: String? = nil
    @State private var scheduleToDelete: ScheduleItem? = nil

    /// Filter to only show recurring schedules (exclude one-shot/reminders).
    private var recurringSchedules: [ScheduleItem] {
        schedules.filter { !$0.isOneShot }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Scheduled Tasks")
                    .font(.headline)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding()

            Divider()

            if isLoading {
                Spacer()
                ProgressView()
                Spacer()
            } else if let errorMessage {
                Spacer()
                VStack(spacing: 8) {
                    VIconView(.triangleAlert, size: 32)
                        .foregroundStyle(.secondary)
                    Text("Failed to load schedules")
                        .foregroundStyle(.secondary)
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Button("Retry") { loadSchedules() }
                        .padding(.top, 4)
                }
                Spacer()
            } else if recurringSchedules.isEmpty {
                Spacer()
                VStack(spacing: 8) {
                    VIconView(.clock, size: 32)
                        .foregroundStyle(.secondary)
                    Text("No scheduled tasks")
                        .foregroundStyle(.secondary)
                    Text("Ask the assistant to create a scheduled task")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                Spacer()
            } else {
                List {
                    ForEach(recurringSchedules) { schedule in
                        ScheduleRow(
                            schedule: schedule,
                            onToggle: { enabled in toggleSchedule(id: schedule.id, enabled: enabled) },
                            onRunNow: { runScheduleNow(id: schedule.id) },
                            onDelete: { scheduleToDelete = schedule }
                        )
                    }
                }
            }
        }
        .frame(width: 550, height: 450)
        .onAppear {
            daemonClient.onSchedulesListResponse = { items in
                schedules = items
                isLoading = false
            }
            loadSchedules()
        }
        .onDisappear {
            daemonClient.onSchedulesListResponse = nil
        }
        .alert("Delete Scheduled Task?", isPresented: Binding(
            get: { scheduleToDelete != nil },
            set: { if !$0 { scheduleToDelete = nil } }
        )) {
            Button("Cancel", role: .cancel) { scheduleToDelete = nil }
            Button("Delete", role: .destructive) {
                if let schedule = scheduleToDelete {
                    deleteSchedule(id: schedule.id)
                    scheduleToDelete = nil
                }
            }
        } message: {
            if let schedule = scheduleToDelete {
                Text("Remove the scheduled task \"\(schedule.name)\"?")
            }
        }
    }

    @MainActor private func loadSchedules() {
        isLoading = true
        errorMessage = nil
        do {
            try daemonClient.sendListSchedules()
        } catch {
            isLoading = false
            errorMessage = error.localizedDescription
        }
    }

    @MainActor private func toggleSchedule(id: String, enabled: Bool) {
        try? daemonClient.sendToggleSchedule(id: id, enabled: enabled)
    }

    @MainActor private func runScheduleNow(id: String) {
        try? daemonClient.sendRunScheduleNow(id: id)
    }

    @MainActor private func deleteSchedule(id: String) {
        try? daemonClient.sendRemoveSchedule(id: id)
    }
}

// MARK: - Schedule Row

private struct ScheduleRow: View {
    let schedule: ScheduleItem
    let onToggle: (Bool) -> Void
    let onRunNow: () -> Void
    let onDelete: () -> Void

    @State private var isExpanded = false
    @State private var isTriggered = false

    private var nextRunText: String {
        guard schedule.enabled else { return "Paused" }
        let date = Date(timeIntervalSince1970: Double(schedule.nextRunAt) / 1000.0)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private var statusColor: Color {
        switch schedule.lastStatus {
        case "ok": return .green
        case "error": return .red
        default: return .secondary
        }
    }

    private var syntaxLabel: String {
        schedule.syntax == "rrule" ? "rrule" : "cron"
    }

    private var syntaxColor: Color {
        schedule.syntax == "rrule" ? .purple : .blue
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(schedule.name)
                            .fontWeight(.medium)
                        Text(syntaxLabel)
                            .font(.caption2)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(syntaxColor.opacity(0.12))
                            .foregroundStyle(syntaxColor)
                            .clipShape(Capsule())
                        if let status = schedule.lastStatus {
                            Text(status)
                                .font(.caption)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(statusColor.opacity(0.15))
                                .foregroundStyle(statusColor)
                                .clipShape(Capsule())
                        }
                    }
                    Text(schedule.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(schedule.expression)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    HStack(spacing: 6) {
                        if schedule.enabled {
                            Text("Next: \(nextRunText)")
                        } else {
                            Text("Disabled")
                        }
                        if let tz = schedule.timezone {
                            Text("(\(tz))")
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                }

                Spacer()

                Button {
                    guard !isTriggered else { return }
                    onRunNow()
                    withAnimation(.easeInOut(duration: 0.2)) { isTriggered = true }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        withAnimation(.easeInOut(duration: 0.2)) { isTriggered = false }
                    }
                } label: {
                    VIconView(isTriggered ? .circleCheck : .play, size: 14)
                        .foregroundStyle(isTriggered ? .green : .blue)
                }
                .buttonStyle(.borderless)
                .help("Run now")

                VToggle(isOn: Binding(
                    get: { schedule.enabled },
                    set: { onToggle($0) }
                ))

                Button {
                    onDelete()
                } label: {
                    VIconView(.trash, size: 14)
                        .foregroundStyle(.red)
                }
                .buttonStyle(.borderless)
            }

            Button {
                withAnimation(.easeInOut(duration: 0.2)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 4) {
                    VIconView(.chevronRight, size: 9)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    Text("Task definition")
                        .font(.caption2)
                }
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)

            if isExpanded {
                Text(schedule.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.05))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(.vertical, 2)
    }
}
