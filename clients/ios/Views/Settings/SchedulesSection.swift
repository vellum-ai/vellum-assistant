#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct SchedulesSection: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @State private var schedules: [ScheduleItem] = []
    @State private var loading = false
    private let scheduleClient: ScheduleClientProtocol = ScheduleClient()

    /// Filter to only show recurring schedules (exclude one-shot/reminders).
    private var recurringSchedules: [ScheduleItem] {
        schedules.filter { !$0.isOneShot }
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
                } else if recurringSchedules.isEmpty {
                    Text("No scheduled tasks")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                } else {
                    ForEach(recurringSchedules, id: \.id) { schedule in
                        scheduleRow(schedule)
                    }
                    .onDelete { indexSet in
                        let schedulesToDelete = indexSet.map { recurringSchedules[$0] }
                        for schedule in schedulesToDelete {
                            deleteSchedule(schedule.id)
                        }
                    }
                }
            }
        }
        .navigationTitle("Scheduled Tasks")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { loadSchedules() }
        .onChange(of: clientProvider.isConnected) { _, connected in
            if connected { loadSchedules() }
        }
    }

    @ViewBuilder
    private func scheduleRow(_ schedule: ScheduleItem) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(schedule.name)
                        .font(.body)
                    Text(schedule.syntax == "rrule" ? "rrule" : "cron")
                        .font(.caption2)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background((schedule.syntax == "rrule" ? Color.purple : Color.blue).opacity(0.12))
                        .foregroundStyle(schedule.syntax == "rrule" ? .purple : .blue)
                        .clipShape(Capsule())
                }
                Text(schedule.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                HStack(spacing: 4) {
                    if let expression = schedule.expression {
                        Text(expression)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    if schedule.enabled, schedule.nextRunAt > 0, let nextRun = formatTimestamp(schedule.nextRunAt) {
                        Text("Next: \(nextRun)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            Spacer()
            Toggle("", isOn: Binding(
                get: { schedule.enabled },
                set: { newValue in toggleSchedule(schedule.id, enabled: newValue) }
            ))
            .labelsHidden()
        }
    }

    private func loadSchedules() {
        loading = true
        Task {
            do {
                let items = try await scheduleClient.fetchSchedulesList()
                schedules = items
            } catch {
                // Silently handle errors; the list remains unchanged.
            }
            loading = false
        }
    }

    private func toggleSchedule(_ id: String, enabled: Bool) {
        Task {
            let items = try? await scheduleClient.toggleSchedule(id: id, enabled: enabled)
            if let items { schedules = items }
        }
    }

    private func deleteSchedule(_ id: String) {
        schedules.removeAll { $0.id == id }
        Task {
            _ = try? await scheduleClient.deleteSchedule(id: id)
        }
    }

    private func formatTimestamp(_ ms: Int) -> String? {
        DateFormatting.relativeTimestamp(fromMilliseconds: ms)
    }
}
#endif
