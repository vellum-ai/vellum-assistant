import SwiftUI
import VellumAssistantShared

struct RemindersView: View {
    let daemonClient: DaemonClient
    @Environment(\.dismiss) var dismiss

    @State private var reminders: [ReminderItem] = []
    @State private var isLoading = true
    @State private var errorMessage: String? = nil
    @State private var reminderToCancel: ReminderItem? = nil

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
                    Image(systemName: "exclamationmark.triangle")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                    Text("Failed to load reminders")
                        .foregroundStyle(.secondary)
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Button("Retry") { loadReminders() }
                        .padding(.top, 4)
                }
                Spacer()
            } else if reminders.isEmpty {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "bell.badge")
                        .font(.largeTitle)
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
                    ForEach(reminders) { reminder in
                        ReminderRow(
                            reminder: reminder,
                            onCancel: { reminderToCancel = reminder }
                        )
                    }
                }
            }
        }
        .frame(width: 550, height: 450)
        .onAppear {
            daemonClient.onRemindersListResponse = { items in
                reminders = items
                isLoading = false
            }
            loadReminders()
        }
        .onDisappear {
            daemonClient.onRemindersListResponse = nil
        }
        .alert("Cancel Reminder?", isPresented: Binding(
            get: { reminderToCancel != nil },
            set: { if !$0 { reminderToCancel = nil } }
        )) {
            Button("Keep", role: .cancel) { reminderToCancel = nil }
            Button("Cancel Reminder", role: .destructive) {
                if let reminder = reminderToCancel {
                    cancelReminder(id: reminder.id)
                    reminderToCancel = nil
                }
            }
        } message: {
            if let reminder = reminderToCancel {
                Text("Cancel the reminder \"\(reminder.label)\"?")
            }
        }
    }

    @MainActor private func loadReminders() {
        isLoading = true
        errorMessage = nil
        do {
            try daemonClient.sendListReminders()
        } catch {
            isLoading = false
            errorMessage = error.localizedDescription
        }
    }

    @MainActor private func cancelReminder(id: String) {
        try? daemonClient.sendCancelReminder(id: id)
    }
}

// MARK: - Reminder Row

private struct ReminderRow: View {
    let reminder: ReminderItem
    let onCancel: () -> Void

    private var fireAtText: String {
        let date = Date(timeIntervalSince1970: Double(reminder.fireAt) / 1000.0)
        if reminder.status == "pending" {
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .abbreviated
            return formatter.localizedString(for: date, relativeTo: Date())
        } else {
            let formatter = DateFormatter()
            formatter.dateStyle = .medium
            formatter.timeStyle = .short
            return formatter.string(from: date)
        }
    }

    private var statusColor: Color {
        switch reminder.status {
        case "pending": return .blue
        case "fired": return .green
        case "cancelled": return .secondary
        default: return .secondary
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(reminder.label)
                        .fontWeight(.medium)
                    Text(reminder.status)
                        .font(.caption)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(statusColor.opacity(0.15))
                        .foregroundStyle(statusColor)
                        .clipShape(Capsule())
                }
                Text(reminder.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(reminder.status == "pending" ? "Fires: \(fireAtText)" : "Fired: \(fireAtText)")
                    Text("(\(reminder.mode))")
                }
                .font(.caption2)
                .foregroundStyle(.tertiary)
            }

            Spacer()

            if reminder.status == "pending" {
                Button {
                    onCancel()
                } label: {
                    Image(systemName: "xmark.circle")
                        .foregroundStyle(.red)
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 2)
    }
}
