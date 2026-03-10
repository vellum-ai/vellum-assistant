#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct RemindersSection: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @State private var schedules: [ScheduleItem] = []
    @State private var loading = false

    /// Filter to only show one-shot schedules (reminders).
    private var oneShotSchedules: [ScheduleItem] {
        schedules.filter { $0.isOneShot }
    }

    var body: some View {
        Form {
            Section {
                if loading {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                } else if oneShotSchedules.isEmpty {
                    Text("No active reminders")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                } else {
                    ForEach(oneShotSchedules, id: \.id) { schedule in
                        reminderRow(schedule)
                    }
                    .onDelete { indexSet in
                        let items = indexSet.map { oneShotSchedules[$0] }
                        for item in items {
                            cancelSchedule(item.id)
                        }
                    }
                }
            }
        }
        .navigationTitle("Reminders")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { loadSchedules() }
        .onChange(of: clientProvider.isConnected) { _, connected in
            if connected { loadSchedules() }
        }
        .onDisappear {
            if let daemon = clientProvider.client as? DaemonClient {
                daemon.onSchedulesListResponse = nil
            }
        }
    }

    @ViewBuilder
    private func reminderRow(_ schedule: ScheduleItem) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(schedule.name)
                .font(.body)
            Text(schedule.message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            HStack(spacing: 8) {
                statusBadge(schedule.status)
                if let fireTime = formatTimestamp(schedule.nextRunAt) {
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
            case "active": return (VColor.warning, "Active")
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

    private func loadSchedules() {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        loading = true
        daemon.onSchedulesListResponse = { items in
            schedules = items
            loading = false
        }
        do {
            try daemon.sendListSchedules()
        } catch {
            loading = false
        }
    }

    private func cancelSchedule(_ id: String) {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        try? daemon.sendRemoveSchedule(id: id)
        schedules.removeAll { $0.id == id }
    }

    private func formatTimestamp(_ ms: Int) -> String? {
        DateFormatting.relativeTimestamp(fromMilliseconds: ms)
    }
}
#endif
