import SwiftUI
import VellumAssistantShared

@MainActor
struct SettingsSchedulesTab: View {
    @State private var schedules: [ScheduleItem] = []
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var deleteConfirmId: String?
    @State private var runningScheduleIds: Set<String> = []
    @State private var expandedScheduleId: String?
    @State private var isSaving = false
    @State private var editName: String = ""
    @State private var editExpression: String = ""
    @State private var editMessage: String = ""
    @State private var editMode: String = ""
    @State private var editTimezone: String = ""

    // System task state
    @State private var heartbeatConfig: HeartbeatConfigResponse?
    @State private var filingConfig: FilingConfigResponse?
    @State private var isHeartbeatRunning = false
    @State private var isFilingRunning = false

    private let scheduleClient: ScheduleClientProtocol = ScheduleClient()
    private let heartbeatClient: HeartbeatClientProtocol = HeartbeatClient()
    private let filingClient: FilingClientProtocol = FilingClient()

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if !isLoading {
                header
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task {
            await loadAll()
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

    // MARK: - Header

    @ViewBuilder
    private var header: some View {
        let scheduleCount = loadError != nil ? 0 : schedules.count
        let total = scheduleCount + systemTaskCount
        Text("\(total) Scheduled Job\(total == 1 ? "" : "s")")
            .font(VFont.titleSmall)
            .foregroundStyle(VColor.contentDefault)
    }

    private var systemTaskCount: Int {
        var count = 0
        if heartbeatConfig != nil { count += 1 }
        if filingConfig != nil { count += 1 }
        return count
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if isLoading {
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: 120)
        } else if schedules.isEmpty && heartbeatConfig == nil && filingConfig == nil {
            if let error = loadError {
                errorView(error)
            } else {
                VEmptyState(
                    title: "No schedules",
                    subtitle: "Schedules you create through conversation will appear here.",
                    icon: VIcon.clock.rawValue
                )
            }
        } else {
            scheduleList
        }
    }

    private var recurringSchedules: [ScheduleItem] {
        let recurring = schedules.filter { !$0.isOneShot }
        return recurring.sorted { a, b in
            if a.enabled != b.enabled { return a.enabled }
            return a.nextRunAt < b.nextRunAt
        }
    }

    private var oneTimeSchedules: [ScheduleItem] {
        let oneTime = schedules.filter { $0.isOneShot }
        return oneTime.sorted { a, b in
            let aTime = a.lastRunAt ?? a.nextRunAt
            let bTime = b.lastRunAt ?? b.nextRunAt
            return aTime > bTime
        }
    }

    @ViewBuilder
    private var scheduleList: some View {
        VStack(spacing: VSpacing.sm) {
            if let error = loadError {
                errorView(error)
            } else {
                ForEach(recurringSchedules, id: \.id) { schedule in
                    scheduleRow(schedule)
                }

                if !oneTimeSchedules.isEmpty {
                    Text("One-time")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .padding(.top, VSpacing.sm)

                    ForEach(oneTimeSchedules, id: \.id) { schedule in
                        scheduleRow(schedule)
                    }
                }
            }

            if heartbeatConfig != nil || filingConfig != nil {
                systemSection
            }
        }
    }

    // MARK: - Schedule Row

    @ViewBuilder
    private func scheduleRow(_ schedule: ScheduleItem) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: VSpacing.md) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(spacing: VSpacing.sm) {
                        Text(schedule.name)
                            .font(VFont.bodyMediumEmphasised)
                            .foregroundStyle(VColor.contentDefault)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        HStack(spacing: VSpacing.xs) {
                            VBadge(
                                label: schedule.mode,
                                tone: modeBadgeTone(schedule.mode),
                                emphasis: .subtle
                            )
                            if schedule.isOneShot {
                                VBadge(label: "one-shot", tone: .neutral, emphasis: .subtle)
                            }
                        }
                    }
                    HStack(spacing: VSpacing.md) {
                        if let nextRun = formatNextRun(schedule.nextRunAt, timezone: schedule.timezone) {
                            Text("Next: \(nextRun)")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentTertiary)
                        }
                        if let lastRunAt = schedule.lastRunAt, let lastRun = formatEpochMs(lastRunAt) {
                            HStack(spacing: VSpacing.xs) {
                                statusDot(schedule.lastStatus)
                                Text("Last: \(lastRun)")
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentTertiary)
                            }
                        }
                    }
                }
                Spacer(minLength: VSpacing.md)
                scheduleRowActions(schedule)
            }
            .padding(VSpacing.md)

            if expandedScheduleId == schedule.id {
                scheduleEditSection(schedule)
                    .padding(EdgeInsets(top: 0, leading: VSpacing.md, bottom: VSpacing.md, trailing: VSpacing.md))
            }
        }
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .animation(.easeInOut(duration: 0.2), value: expandedScheduleId)
    }

    @ViewBuilder
    private func scheduleRowActions(_ schedule: ScheduleItem) -> some View {
        HStack(spacing: VSpacing.xs) {
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
            VToggle(
                isOn: toggleBinding(for: schedule),
                interactive: true
            )
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
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    // MARK: - System Section

    @ViewBuilder
    private var systemSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if !schedules.isEmpty {
                Text("System")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .padding(.top, VSpacing.sm)
            }

            if let config = heartbeatConfig {
                systemRow(
                    name: "Heartbeat",
                    subtitle: heartbeatSubtitle(config),
                    enabled: config.enabled,
                    nextRunAt: config.nextRunAt,
                    lastRunAt: config.lastRunAt,
                    isRunning: isHeartbeatRunning,
                    onRunNow: { runHeartbeatNow() },
                    onToggle: nil
                )
            }

            if let config = filingConfig {
                systemRow(
                    name: "Filing",
                    subtitle: filingSubtitle(config),
                    enabled: config.enabled,
                    nextRunAt: config.nextRunAt,
                    lastRunAt: config.lastRunAt,
                    isRunning: isFilingRunning,
                    onRunNow: { runFilingNow() },
                    onToggle: nil
                )
            }
        }
    }

    @ViewBuilder
    private func systemRow(
        name: String,
        subtitle: String,
        enabled: Bool,
        nextRunAt: Int?,
        lastRunAt: Int?,
        isRunning: Bool,
        onRunNow: @escaping () -> Void,
        onToggle: ((Bool) -> Void)?
    ) -> some View {
        HStack(alignment: .center, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack(spacing: VSpacing.sm) {
                    Text(name)
                        .font(VFont.bodyMediumEmphasised)
                        .foregroundStyle(VColor.contentDefault)
                    VBadge(label: "system", tone: .neutral, emphasis: .subtle)
                }
                Text(subtitle)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                HStack(spacing: VSpacing.md) {
                    if let nextRunAt, let nextRun = formatEpochMs(nextRunAt) {
                        Text("Next: \(nextRun)")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                    if let lastRunAt, let lastRun = formatEpochMs(lastRunAt) {
                        Text("Last: \(lastRun)")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                }
            }
            Spacer(minLength: VSpacing.md)
            HStack(spacing: VSpacing.xs) {
                if isRunning {
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
                        onRunNow()
                    }
                }
                Circle()
                    .fill(enabled ? VColor.systemPositiveStrong : VColor.contentDisabled)
                    .frame(width: 8, height: 8)
                    .padding(.leading, VSpacing.xs)
            }
        }
        .padding(VSpacing.md)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }

    // MARK: - Status Dot

    @ViewBuilder
    private func statusDot(_ status: String?) -> some View {
        Circle()
            .fill(statusDotColor(status))
            .frame(width: 6, height: 6)
    }

    private func statusDotColor(_ status: String?) -> Color {
        switch status {
        case "ok":
            return VColor.systemPositiveStrong
        case "error":
            return VColor.systemNegativeStrong
        default:
            return VColor.contentTertiary
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
                Task { await loadAll() }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 120)
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

    private func loadAll() async {
        isLoading = true
        loadError = nil
        do {
            let items = try await scheduleClient.fetchSchedulesList()
            schedules = items
        } catch {
            loadError = "Failed to load schedules. \(error.localizedDescription)"
        }
        heartbeatConfig = await heartbeatClient.fetchConfig()
        filingConfig = await filingClient.fetchConfig()
        isLoading = false
    }

    private func toggleSchedule(_ id: String, enabled: Bool) {
        guard let index = schedules.firstIndex(where: { $0.id == id }) else { return }
        let snapshot = schedules
        let old = schedules[index]
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
                await loadAll()
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
                await loadAll()
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
        if editName != schedule.name { updates["name"] = editName }
        let originalExpression = schedule.expression ?? schedule.cronExpression ?? ""
        if editExpression != originalExpression { updates["expression"] = editExpression }
        if editMessage != schedule.message { updates["message"] = editMessage }
        if editMode != schedule.mode { updates["mode"] = editMode }
        let originalTimezone = schedule.timezone ?? ""
        if editTimezone != originalTimezone { updates["timezone"] = editTimezone }

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
                await loadAll()
            }
            runningScheduleIds.remove(schedule.id)
        }
    }

    private func runHeartbeatNow() {
        isHeartbeatRunning = true
        Task {
            _ = await heartbeatClient.runNow()
            heartbeatConfig = await heartbeatClient.fetchConfig()
            isHeartbeatRunning = false
        }
    }

    private func runFilingNow() {
        isFilingRunning = true
        Task {
            _ = await filingClient.runNow()
            filingConfig = await filingClient.fetchConfig()
            isFilingRunning = false
        }
    }

    // MARK: - Helpers

    private func modeBadgeTone(_ mode: String) -> VBadge.Tone {
        switch mode {
        case "execute": return .positive
        case "script": return .accent
        case "notify": return .warning
        default: return .neutral
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

    private func filingSubtitle(_ config: FilingConfigResponse) -> String {
        let minutes = Int(config.intervalMs / 60_000)
        var subtitle: String
        if minutes >= 60 && minutes % 60 == 0 {
            subtitle = "Every \(minutes / 60) hr"
        } else {
            subtitle = "Every \(minutes) min"
        }
        if let start = config.activeHoursStart, let end = config.activeHoursEnd {
            subtitle += " (\(Int(start)):00\u{2013}\(Int(end)):00)"
        }
        return subtitle
    }

    private func formatNextRun(_ ms: Int, timezone: String?) -> String? {
        guard ms > 0 else { return nil }
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d, yyyy 'at' h:mm a zzz"
        if let tz = timezone, let timeZone = TimeZone(identifier: tz) {
            formatter.timeZone = timeZone
        }
        return formatter.string(from: date)
    }

    private func formatEpochMs(_ ms: Int) -> String? {
        guard ms > 0 else { return nil }
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
