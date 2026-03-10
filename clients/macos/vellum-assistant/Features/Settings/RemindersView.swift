import SwiftUI
import VellumAssistantShared

struct RemindersView: View {
    let daemonClient: DaemonClient
    @Environment(\.dismiss) var dismiss

    @State private var schedules: [ScheduleItem] = []
    @State private var isLoading = true
    @State private var errorMessage: String? = nil
    @State private var scheduleToCancel: ScheduleItem? = nil

    /// Filter to only show one-shot schedules (reminders).
    private var oneShotSchedules: [ScheduleItem] {
        schedules.filter { $0.isOneShot }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Reminders")
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
                    Text("Failed to load reminders")
                        .foregroundStyle(.secondary)
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .textSelection(.enabled)
                    Button("Retry") { loadSchedules() }
                        .padding(.top, 4)
                }
                Spacer()
            } else if oneShotSchedules.isEmpty {
                Spacer()
                VStack(spacing: 8) {
                    VIconView(.bellDot, size: 32)
                        .foregroundStyle(.secondary)
                    Text("No reminders")
                        .foregroundStyle(.secondary)
                    Text("Ask the assistant to create a reminder")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                Spacer()
            } else {
                List {
                    ForEach(oneShotSchedules) { schedule in
                        ReminderRow(
                            schedule: schedule,
                            onCancel: { scheduleToCancel = schedule }
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
        .alert("Cancel Reminder?", isPresented: Binding(
            get: { scheduleToCancel != nil },
            set: { if !$0 { scheduleToCancel = nil } }
        )) {
            Button("Keep", role: .cancel) { scheduleToCancel = nil }
            Button("Cancel Reminder", role: .destructive) {
                if let schedule = scheduleToCancel {
                    cancelSchedule(id: schedule.id)
                    scheduleToCancel = nil
                }
            }
        } message: {
            if let schedule = scheduleToCancel {
                Text("Cancel the reminder \"\(schedule.name)\"?")
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

    @MainActor private func cancelSchedule(id: String) {
        try? daemonClient.sendRemoveSchedule(id: id)
    }
}

// MARK: - Reminder Row

private struct ReminderRow: View {
    let schedule: ScheduleItem
    let onCancel: () -> Void

    private var scheduledDateText: String {
        let date = Date(timeIntervalSince1970: Double(schedule.nextRunAt) / 1000.0)
        let formatter = DateFormatter()
        formatter.timeZone = .autoupdatingCurrent
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    private var statusDateText: String {
        switch schedule.status {
        case "active":
            let date = Date(timeIntervalSince1970: Double(schedule.nextRunAt) / 1000.0)
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .abbreviated
            return "Fires: \(formatter.localizedString(for: date, relativeTo: Date()))"
        case "fired":
            let timestamp = schedule.lastRunAt ?? schedule.nextRunAt
            let date = Date(timeIntervalSince1970: Double(timestamp) / 1000.0)
            let formatter = DateFormatter()
            formatter.timeZone = .autoupdatingCurrent
            formatter.dateStyle = .medium
            formatter.timeStyle = .short
            return "Fired: \(formatter.string(from: date))"
        default:
            return "Scheduled for: \(scheduledDateText)"
        }
    }

    private var statusColor: Color {
        switch schedule.status {
        case "active": return .blue
        case "fired": return .green
        case "cancelled": return .secondary
        default: return .secondary
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(schedule.name)
                        .fontWeight(.medium)
                    Text(schedule.status)
                        .font(.caption)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(statusColor.opacity(0.15))
                        .foregroundStyle(statusColor)
                        .clipShape(Capsule())
                }
                Text(schedule.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(statusDateText)
                    Text("(\(schedule.mode))")
                }
                .font(.caption2)
                .foregroundStyle(.tertiary)
            }
            .textSelection(.enabled)

            Spacer()

            if schedule.status == "active" {
                Button {
                    onCancel()
                } label: {
                    VIconView(.circleX, size: 14)
                        .foregroundStyle(.red)
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 2)
    }
}
