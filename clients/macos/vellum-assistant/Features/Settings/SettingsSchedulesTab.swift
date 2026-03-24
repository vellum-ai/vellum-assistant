import SwiftUI
import VellumAssistantShared

@MainActor
struct SettingsSchedulesTab: View {
    @State private var schedules: [ScheduleItem] = []
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var deleteConfirmId: String?
    @State private var expandedScheduleId: String?
    @State private var runningScheduleIds: Set<String> = []
    @State private var isSaving = false
    @State private var editName: String = ""
    @State private var editExpression: String = ""
    @State private var editMessage: String = ""
    @State private var editMode: String = ""
    @State private var editTimezone: String = ""

    // Heartbeat state
    @State private var heartbeatConfig: HeartbeatConfigResponse?
    @State private var isHeartbeatRunning = false

    private let scheduleClient: ScheduleClientProtocol = ScheduleClient()
    private let heartbeatClient: HeartbeatClientProtocol = HeartbeatClient()

    // MARK: - Computed Filters

    private var recurringSchedules: [ScheduleItem] {
        schedules.filter { !$0.isOneShot }
    }

    private var oneShotSchedules: [ScheduleItem] {
        schedules.filter { $0.isOneShot }
    }

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if let config = heartbeatConfig {
                heartbeatCard(config)
            }

            if isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = loadError {
                errorView(error)
            } else if schedules.isEmpty && heartbeatConfig == nil {
                VEmptyState(
                    title: "No schedules",
                    subtitle: "Schedules you create through conversation will appear here.",
                    icon: VIcon.clock.rawValue
                )
            } else {
                scheduleGroups
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task {
            await loadSchedules()
            heartbeatConfig = await heartbeatClient.fetchConfig()
        }
        .alert("Delete Schedule", isPresented: deleteConfirmBinding) {
            Button("Cancel", role: .cancel) {
                deleteConfirmId = nil
            }
            Button("Delete", role: .destructive) {
                if let id = deleteConfirmId {
                    deleteSchedule(id)
                }
            }
        } message: {
            Text("This schedule will be permanently removed.")
        }
    }

    // MARK: - Schedule Groups

    @ViewBuilder
    private var scheduleGroups: some View {
        if !recurringSchedules.isEmpty {
            SettingsCard(
                title: "Recurring Schedules",
                subtitle: "\(recurringSchedules.count) schedule(s)"
            ) {
                ForEach(recurringSchedules, id: \.id) { schedule in
                    scheduleRow(schedule)
                    if schedule.id != recurringSchedules.last?.id {
                        SettingsDivider()
                    }
                }
            }
        }
        if !oneShotSchedules.isEmpty {
            SettingsCard(
                title: "One-Time Schedules",
                subtitle: "\(oneShotSchedules.count) schedule(s)"
            ) {
                ForEach(oneShotSchedules, id: \.id) { schedule in
                    scheduleRow(schedule)
                    if schedule.id != oneShotSchedules.last?.id {
                        SettingsDivider()
                    }
                }
            }
        }
    }

    // MARK: - Schedule Row

    @ViewBuilder
    private func scheduleRow(_ schedule: ScheduleItem) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: VSpacing.md) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    scheduleRowHeader(schedule)
                    scheduleRowBadges(schedule)
                    scheduleRowDescription(schedule)
                    scheduleRowTimes(schedule)
                }
                Spacer()
                scheduleRowActions(schedule)
            }

            if expandedScheduleId == schedule.id {
                scheduleEditSection(schedule)
            }
        }
        .padding(.vertical, VSpacing.sm)
        .animation(.easeInOut(duration: 0.2), value: expandedScheduleId)
    }

    @ViewBuilder
    private func scheduleRowHeader(_ schedule: ScheduleItem) -> some View {
        HStack(spacing: VSpacing.sm) {
            statusIndicator(for: schedule)
            Text(schedule.name)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }

    @ViewBuilder
    private func scheduleRowBadges(_ schedule: ScheduleItem) -> some View {
        HStack(spacing: VSpacing.xs) {
            VBadge(
                label: schedule.syntax,
                tone: schedule.syntax == "rrule" ? .warning : .accent,
                emphasis: .subtle
            )
            VBadge(
                label: schedule.mode,
                tone: schedule.mode == "execute" ? .positive : .neutral,
                emphasis: .subtle
            )
        }
    }

    @ViewBuilder
    private func scheduleRowDescription(_ schedule: ScheduleItem) -> some View {
        Text(schedule.description)
            .font(VFont.labelDefault)
            .foregroundStyle(VColor.contentTertiary)
            .lineLimit(2)
    }

    @ViewBuilder
    private func scheduleRowTimes(_ schedule: ScheduleItem) -> some View {
        HStack(spacing: VSpacing.md) {
            if let nextRun = formatEpochMs(schedule.nextRunAt) {
                Text("Next: \(nextRun)")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            if let lastRunAt = schedule.lastRunAt, let lastRun = formatEpochMs(lastRunAt) {
                Text("Last: \(lastRun)")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    @ViewBuilder
    private func scheduleRowActions(_ schedule: ScheduleItem) -> some View {
        HStack(spacing: VSpacing.xs) {
            VToggle(
                isOn: toggleBinding(for: schedule),
                interactive: true
            )
            if runningScheduleIds.contains(schedule.id) {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 20, height: 20)
            } else {
                VButton(
                    label: "Run Now",
                    iconOnly: VIcon.play.rawValue,
                    style: .ghost,
                    tooltip: "Run now"
                ) {
                    runNow(schedule)
                }
            }
            VButton(
                label: "Edit",
                iconOnly: VIcon.pencil.rawValue,
                style: .ghost,
                tooltip: "Edit schedule"
            ) {
                beginEditing(schedule)
            }
            if schedule.isOneShot && schedule.status == "active" {
                VButton(
                    label: "Cancel",
                    iconOnly: VIcon.circleX.rawValue,
                    style: .ghost,
                    tooltip: "Cancel schedule"
                ) {
                    cancelSchedule(schedule.id)
                }
            }
            VButton(
                label: "Delete",
                iconOnly: VIcon.trash.rawValue,
                style: .ghost,
                tooltip: "Delete schedule"
            ) {
                deleteConfirmId = schedule.id
            }
        }
    }

    // MARK: - Edit Section

    @ViewBuilder
    private func scheduleEditSection(_ schedule: ScheduleItem) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VTextField(placeholder: "Name", text: $editName)
            VTextField(placeholder: "Expression", text: $editExpression)
            VTextField(placeholder: "Message", text: $editMessage)
            HStack(spacing: VSpacing.sm) {
                VDropdown(
                    placeholder: "Mode",
                    selection: $editMode,
                    options: [
                        (label: "Execute", value: "execute"),
                        (label: "Notify", value: "notify")
                    ],
                    maxWidth: 150
                )
                VTextField(placeholder: "Timezone", text: $editTimezone)
            }
            HStack(spacing: VSpacing.sm) {
                VButton(label: "Save", style: .primary, isDisabled: isSaving) {
                    saveEdits(schedule)
                }
                VButton(label: "Cancel", style: .ghost) {
                    expandedScheduleId = nil
                }
            }
        }
        .padding(.top, VSpacing.sm)
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    // MARK: - Status Indicator

    @ViewBuilder
    private func statusIndicator(for schedule: ScheduleItem) -> some View {
        Circle()
            .fill(statusColor(for: schedule))
            .frame(width: 8, height: 8)
            .accessibilityLabel("Status: \(schedule.status)")
    }

    private func statusColor(for schedule: ScheduleItem) -> Color {
        if !schedule.enabled {
            return VColor.contentDisabled
        }
        switch schedule.status {
        case "active":
            return VColor.systemPositiveStrong
        case "firing":
            return VColor.systemMidStrong
        case "fired", "cancelled":
            return VColor.contentTertiary
        default:
            return VColor.contentDisabled
        }
    }

    // MARK: - Error View

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
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Bindings

    private var deleteConfirmBinding: Binding<Bool> {
        Binding(
            get: { deleteConfirmId != nil },
            set: { newValue in
                if !newValue { deleteConfirmId = nil }
            }
        )
    }

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

    private func deleteSchedule(_ id: String) {
        schedules.removeAll { $0.id == id }
        Task {
            do {
                let items = try await scheduleClient.deleteSchedule(id: id)
                schedules = items
            } catch {
                // Reload on error to restore consistent state
                await loadSchedules()
            }
        }
        deleteConfirmId = nil
    }

    private func cancelSchedule(_ id: String) {
        Task {
            do {
                let items = try await scheduleClient.cancelSchedule(id: id)
                schedules = items
            } catch {
                // Reload on error
                await loadSchedules()
            }
        }
    }

    private func beginEditing(_ schedule: ScheduleItem) {
        expandedScheduleId = schedule.id
        editName = schedule.name
        editExpression = schedule.expression ?? schedule.cronExpression ?? ""
        editMessage = schedule.message
        editMode = schedule.mode
        editTimezone = schedule.timezone ?? ""
    }

    private func saveEdits(_ schedule: ScheduleItem) {
        var updates: [String: Any] = [:]
        if editName != schedule.name {
            updates["name"] = editName
        }
        let originalExpression = schedule.expression ?? schedule.cronExpression ?? ""
        if editExpression != originalExpression {
            updates["expression"] = editExpression
        }
        if editMessage != schedule.message {
            updates["message"] = editMessage
        }
        if editMode != schedule.mode {
            updates["mode"] = editMode
        }
        let originalTimezone = schedule.timezone ?? ""
        if editTimezone != originalTimezone {
            updates["timezone"] = editTimezone
        }

        guard !updates.isEmpty else {
            expandedScheduleId = nil
            return
        }

        isSaving = true
        Task {
            do {
                let items = try await scheduleClient.updateSchedule(id: schedule.id, updates: updates)
                schedules = items
                expandedScheduleId = nil
            } catch {
                // Keep expanded on error so user can retry
            }
            isSaving = false
        }
    }

    private func runNow(_ schedule: ScheduleItem) {
        runningScheduleIds.insert(schedule.id)
        Task {
            do {
                let items = try await scheduleClient.runNow(id: schedule.id)
                schedules = items
            } catch {
                // Reload on error
                await loadSchedules()
            }
            runningScheduleIds.remove(schedule.id)
        }
    }

    // MARK: - Heartbeat

    @ViewBuilder
    private func heartbeatCard(_ config: HeartbeatConfigResponse) -> some View {
        SettingsCard(
            title: "Heartbeat",
            subtitle: heartbeatSubtitle(config)
        ) {
            HStack(alignment: .top, spacing: VSpacing.md) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(spacing: VSpacing.sm) {
                        Circle()
                            .fill(config.enabled ? VColor.systemPositiveStrong : VColor.contentDisabled)
                            .frame(width: 8, height: 8)
                        Text(config.enabled ? "Enabled" : "Disabled")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentDefault)
                    }
                    if let nextRun = config.nextRunAt, let formatted = formatEpochMs(nextRun) {
                        Text("Next run: \(formatted)")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                }
                Spacer()
                if isHeartbeatRunning {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 20, height: 20)
                } else {
                    VButton(
                        label: "Run Now",
                        iconOnly: VIcon.play.rawValue,
                        style: .ghost,
                        tooltip: "Run heartbeat now"
                    ) {
                        runHeartbeatNow()
                    }
                }
            }
        }
    }

    private func heartbeatSubtitle(_ config: HeartbeatConfigResponse) -> String {
        let interval = Int(config.intervalMs / 60_000)
        var subtitle = "Every \(interval) min"
        if let start = config.activeHoursStart, let end = config.activeHoursEnd {
            subtitle += " (\(Int(start)):00\u{2013}\(Int(end)):00)"
        }
        return subtitle
    }

    private func runHeartbeatNow() {
        isHeartbeatRunning = true
        Task {
            _ = await heartbeatClient.runNow()
            heartbeatConfig = await heartbeatClient.fetchConfig()
            isHeartbeatRunning = false
        }
    }

    // MARK: - Formatting

    private func formatEpochMs(_ ms: Int) -> String? {
        guard ms > 0 else { return nil }
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
