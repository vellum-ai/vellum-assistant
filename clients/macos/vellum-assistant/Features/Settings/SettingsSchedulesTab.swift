import SwiftUI
import VellumAssistantShared

@MainActor
struct SettingsSchedulesTab: View {
    @State private var schedules: [ScheduleItem] = []
    @State private var isLoading = true
    @State private var loadError: String?

    private let scheduleClient: ScheduleClientProtocol = ScheduleClient()

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if !isLoading {
                header
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task {
            await loadSchedules()
        }
    }

    // MARK: - Header

    @ViewBuilder
    private var header: some View {
        Text("\(schedules.count) Scheduled Job\(schedules.count == 1 ? "" : "s")")
            .font(VFont.titleSmall)
            .foregroundStyle(VColor.contentDefault)
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if isLoading {
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: 120)
        } else if let error = loadError {
            errorView(error)
        } else if schedules.isEmpty {
            VEmptyState(
                title: "No schedules",
                subtitle: "Schedules you create through conversation will appear here.",
                icon: VIcon.clock.rawValue
            )
        } else {
            scheduleList
        }
    }

    @ViewBuilder
    private var scheduleList: some View {
        VStack(spacing: VSpacing.sm) {
            ForEach(schedules, id: \.id) { schedule in
                scheduleRow(schedule)
            }
        }
    }

    // MARK: - Row

    @ViewBuilder
    private func scheduleRow(_ schedule: ScheduleItem) -> some View {
        HStack(alignment: .center, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(schedule.name)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)
                HStack(spacing: VSpacing.xs) {
                    Text("Next Run")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    Text(nextRunText(schedule))
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
            }
            Spacer(minLength: VSpacing.md)
            VToggle(
                isOn: toggleBinding(for: schedule),
                interactive: true
            )
        }
        .padding(VSpacing.md)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }

    // MARK: - Error

    @ViewBuilder
    private func errorView(_ error: String) -> some View {
        VStack(spacing: VSpacing.md) {
            Text(error)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.systemNegativeStrong)
            VButton(label: "Retry", style: .outlined) {
                Task { await loadSchedules() }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 120)
    }

    // MARK: - Bindings

    private func toggleBinding(for schedule: ScheduleItem) -> Binding<Bool> {
        Binding(
            get: { schedule.enabled },
            set: { newValue in
                toggleSchedule(schedule.id, enabled: newValue)
            }
        )
    }

    // MARK: - Actions

    private func loadSchedules() async {
        isLoading = true
        loadError = nil
        do {
            let items = try await scheduleClient.fetchSchedulesList()
            schedules = items
        } catch {
            loadError = "Failed to load schedules. \(error.localizedDescription)"
        }
        isLoading = false
    }

    private func toggleSchedule(_ id: String, enabled: Bool) {
        guard let index = schedules.firstIndex(where: { $0.id == id }) else { return }
        let snapshot = schedules
        let old = schedules[index]
        // Optimistic update
        schedules[index] = ScheduleItem(
            id: old.id, name: old.name, enabled: enabled,
            syntax: old.syntax, expression: old.expression,
            cronExpression: old.cronExpression, timezone: old.timezone,
            message: old.message, nextRunAt: old.nextRunAt,
            lastRunAt: old.lastRunAt, lastStatus: old.lastStatus,
            description: old.description, mode: old.mode,
            status: old.status, routingIntent: old.routingIntent,
            isOneShot: old.isOneShot
        )
        Task {
            do {
                let items = try await scheduleClient.toggleSchedule(id: id, enabled: enabled)
                schedules = items
            } catch {
                // Revert on error
                schedules = snapshot
            }
        }
    }

    // MARK: - Formatting

    private func nextRunText(_ schedule: ScheduleItem) -> String {
        guard schedule.nextRunAt > 0 else { return "—" }
        let date = Date(timeIntervalSince1970: Double(schedule.nextRunAt) / 1000)
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d, yyyy 'at' h:mm a zzz"
        if let tz = schedule.timezone, let timeZone = TimeZone(identifier: tz) {
            formatter.timeZone = timeZone
        }
        return formatter.string(from: date)
    }
}
