#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct RemindersSection: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @State private var reminders: [ReminderItem] = []
    @State private var loading = false

    var body: some View {
        Form {
            Section {
                if loading {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                } else if reminders.isEmpty {
                    Text("No active reminders")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                } else {
                    ForEach(reminders, id: \.id) { reminder in
                        reminderRow(reminder)
                    }
                    .onDelete { indexSet in
                        let remindersToCancel = indexSet.map { reminders[$0] }
                        for reminder in remindersToCancel {
                            cancelReminder(reminder.id)
                        }
                    }
                }
            }
        }
        .navigationTitle("Reminders")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { loadReminders() }
        .onChange(of: clientProvider.isConnected) { _, connected in
            if connected { loadReminders() }
        }
        .onDisappear {
            if let daemon = clientProvider.client as? DaemonClient {
                daemon.onRemindersListResponse = nil
            }
        }
    }

    @ViewBuilder
    private func reminderRow(_ reminder: ReminderItem) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(reminder.label)
                .font(.body)
            Text(reminder.message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            HStack(spacing: 8) {
                statusBadge(reminder.status)
                if let fireTime = formatTimestamp(reminder.fireAt) {
                    Text(fireTime)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    @ViewBuilder
    private func statusBadge(_ status: String) -> some View {
        let (color, label): (Color, String) = {
            switch status {
            case "pending": return (VColor.warning, "Pending")
            case "fired": return (VColor.success, "Fired")
            case "cancelled": return (VColor.textMuted, "Cancelled")
            default: return (VColor.textSecondary, status.capitalized)
            }
        }()
        Text(label)
            .font(.caption2)
            .fontWeight(.medium)
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15))
            .clipShape(Capsule())
    }

    private func loadReminders() {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        loading = true
        daemon.onRemindersListResponse = { items in
            reminders = items
            loading = false
        }
        do {
            try daemon.sendListReminders()
        } catch {
            loading = false
        }
    }

    private func cancelReminder(_ id: String) {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        try? daemon.sendCancelReminder(id: id)
        reminders.removeAll { $0.id == id }
    }

    private func formatTimestamp(_ ms: Int) -> String? {
        DateFormatting.relativeTimestamp(fromMilliseconds: ms)
    }
}
#endif
