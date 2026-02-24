#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// MARK: - Pinned App Storage

/// Lightweight codable record for a user-pinned app/URL shortcut.
struct PinnedAppLink: Codable, Identifiable {
    let id: String
    var name: String
    var icon: String?
    var url: String?
    var appType: String?
    var pinnedOrder: Int
}

/// Persists a small list of pinned app links in UserDefaults for iOS.
@MainActor
final class PinnedAppsStore: ObservableObject {
    @Published var pins: [PinnedAppLink] = []

    private static let key = "home_base_pinned_apps_v1"

    init() { load() }

    func pin(_ link: PinnedAppLink) {
        guard !pins.contains(where: { $0.id == link.id }) else { return }
        var updated = link
        updated = PinnedAppLink(
            id: link.id,
            name: link.name,
            icon: link.icon,
            url: link.url,
            appType: link.appType,
            pinnedOrder: pins.count
        )
        pins.append(updated)
        save()
    }

    func unpin(id: String) {
        pins.removeAll { $0.id == id }
        // Recompact order after removal
        for i in pins.indices { pins[i] = PinnedAppLink(
            id: pins[i].id, name: pins[i].name,
            icon: pins[i].icon, url: pins[i].url,
            appType: pins[i].appType, pinnedOrder: i
        )}
        save()
    }

    private func save() {
        if let data = try? JSONEncoder().encode(pins) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }

    private func load() {
        guard let data = UserDefaults.standard.data(forKey: Self.key),
              let decoded = try? JSONDecoder().decode([PinnedAppLink].self, from: data) else { return }
        pins = decoded.sorted { $0.pinnedOrder < $1.pinnedOrder }
    }
}

// MARK: - ViewModel

@MainActor @Observable
final class HomeBaseViewModel {
    var response: HomeBaseGetResponseMessage?
    var isLoading = false

    // Widget data fetched independently
    var recentSessions: [IPCSessionListResponseSession] = []
    var reminders: [ReminderItem] = []
    var isLoadingWidgets = false

    var homeBase: IPCHomeBaseGetResponseHomeBase? {
        response?.homeBase
    }

    func fetch(client: any DaemonClientProtocol) async {
        guard let daemonClient = client as? DaemonClient else { return }
        isLoading = true

        let stream = daemonClient.subscribe()
        do {
            try daemonClient.sendHomeBaseGet(ensureLinked: false)
        } catch {
            isLoading = false
            return
        }

        // Race the stream against a 10-second timeout so isLoading doesn't
        // stay true forever if the daemon ignores this message.
        let msg: HomeBaseGetResponseMessage? = await withTaskGroup(of: HomeBaseGetResponseMessage?.self) { group in
            group.addTask {
                for await message in stream {
                    if case .homeBaseGetResponse(let msg) = message {
                        return msg
                    }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }

        if let msg {
            response = msg
        }
        isLoading = false
    }

    /// Fetch widget data (recent sessions + reminders) from the daemon.
    func fetchWidgets(client: any DaemonClientProtocol) async {
        guard let daemonClient = client as? DaemonClient else { return }
        isLoadingWidgets = true

        async let sessionsTask: () = fetchRecentSessions(daemonClient)
        async let remindersTask: () = fetchReminders(daemonClient)
        _ = await (sessionsTask, remindersTask)

        isLoadingWidgets = false
    }

    private func fetchRecentSessions(_ daemon: DaemonClient) async {
        let stream = daemon.subscribe()
        do {
            try daemon.sendSessionList(limit: 5)
        } catch { return }

        let result: SessionListResponseMessage? = await withTaskGroup(of: SessionListResponseMessage?.self) { group in
            group.addTask {
                for await message in stream {
                    if case .sessionListResponse(let msg) = message { return msg }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }

        if let result {
            recentSessions = Array(result.sessions
                .filter { $0.threadType != "private" }
                .prefix(5))
        }
    }

    private func fetchReminders(_ daemon: DaemonClient) async {
        let stream = daemon.subscribe()
        do {
            try daemon.sendListReminders()
        } catch { return }

        let result: RemindersListResponseMessage? = await withTaskGroup(of: RemindersListResponseMessage?.self) { group in
            group.addTask {
                for await message in stream {
                    if case .remindersListResponse(let msg) = message { return msg }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }

        if let result {
            // Show only upcoming/pending reminders, capped at 5.
            reminders = Array(result.reminders
                .filter { $0.status == "pending" }
                .sorted { $0.fireAt < $1.fireAt }
                .prefix(5))
        }
    }
}

// MARK: - View

struct HomeBaseView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @State private var viewModel = HomeBaseViewModel()
    @StateObject private var pinnedAppsStore = PinnedAppsStore()
    /// Callback to navigate to Settings tab for connection setup.
    var onConnectTapped: (() -> Void)?
    /// Callback to navigate to the Chats tab and open a new thread.
    var onNewConversation: (() -> Void)?

    @State private var showAddPinSheet = false
    @State private var newPinName = ""
    @State private var newPinURL = ""
    @State private var newPinIcon = ""

    var body: some View {
        NavigationStack {
            Group {
                if !clientProvider.isConnected {
                    disconnectedState
                } else if viewModel.isLoading && viewModel.response == nil {
                    loadingState
                } else if let homeBase = viewModel.homeBase {
                    dashboardContent(homeBase)
                } else {
                    // Connected but no HomeBase configured — still show the rich dashboard
                    // skeleton with widgets and quick actions.
                    dashboardContent(nil)
                }
            }
            .navigationTitle("Home")
        }
        .task(id: clientProvider.isConnected) {
            guard clientProvider.isConnected else { return }
            async let fetchHomeBase: () = viewModel.fetch(client: clientProvider.client)
            async let fetchWidgets: () = viewModel.fetchWidgets(client: clientProvider.client)
            _ = await (fetchHomeBase, fetchWidgets)
        }
    }

    // MARK: - Dashboard Content

    private func dashboardContent(_ homeBase: IPCHomeBaseGetResponseHomeBase?) -> some View {
        ScrollView {
            VStack(spacing: VSpacing.lg) {
                // App preview card — show only when a HomeBase is configured
                if let homeBase {
                    appPreviewCard(homeBase.preview)

                    if !homeBase.preview.metrics.isEmpty {
                        metricsSection(homeBase.preview.metrics)
                    }
                }

                // Quick actions — always visible when connected
                quickActionsSection

                // Widget row: recent conversations + reminders
                widgetRowSection

                // Pinned app links — always visible so users can add their first pin
                pinnedAppsSection

                // Starter / onboarding task lists
                if let homeBase {
                    if !homeBase.starterTasks.isEmpty {
                        taskListSection(
                            icon: "star.fill",
                            title: "Starter Tasks",
                            tasks: homeBase.starterTasks
                        )
                    }

                    if !homeBase.onboardingTasks.isEmpty {
                        taskListSection(
                            icon: "checklist",
                            title: "Onboarding",
                            tasks: homeBase.onboardingTasks
                        )
                    }
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.top, VSpacing.md)
            .padding(.bottom, VSpacing.xl)
        }
        .refreshable {
            async let fetchHomeBase: () = viewModel.fetch(client: clientProvider.client)
            async let fetchWidgets: () = viewModel.fetchWidgets(client: clientProvider.client)
            _ = await (fetchHomeBase, fetchWidgets)
        }
    }

    // MARK: - Quick Actions

    private var quickActionsSection: some View {
        VStack(spacing: 0) {
            sectionHeader(icon: "bolt.fill", title: "Quick Actions")

            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
            ], spacing: VSpacing.sm) {
                quickActionButton(
                    icon: "square.and.pencil",
                    label: "New Conversation",
                    color: VColor.accent
                ) {
                    onNewConversation?()
                }

                quickActionButton(
                    icon: "arrow.clockwise",
                    label: "Refresh Home",
                    color: VColor.accent
                ) {
                    Task {
                        async let fetchHomeBase: () = viewModel.fetch(client: clientProvider.client)
                        async let fetchWidgets: () = viewModel.fetchWidgets(client: clientProvider.client)
                        _ = await (fetchHomeBase, fetchWidgets)
                    }
                }

                quickActionButton(
                    icon: "checklist",
                    label: "Run a Task",
                    color: VColor.iconAccent
                ) {
                    // Navigates to a new conversation pre-loaded with task intent.
                    onNewConversation?()
                }

                quickActionButton(
                    icon: "gear",
                    label: "Settings",
                    color: VColor.textMuted
                ) {
                    onConnectTapped?()
                }
            }
            .padding(VSpacing.lg)
        }
        .background(VColor.surface)
        .cornerRadius(VRadius.lg)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Quick Actions")
    }

    private func quickActionButton(icon: String, label: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: VSpacing.xs) {
                ZStack {
                    Circle()
                        .fill(color.opacity(0.12))
                        .frame(width: 44, height: 44)

                    Image(systemName: icon)
                        .font(.system(size: 18, weight: .medium))
                        .foregroundColor(color)
                }

                Text(label)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textPrimary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, VSpacing.sm)
            .background(VColor.backgroundSubtle)
            .cornerRadius(VRadius.md)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    // MARK: - Widget Row

    private var widgetRowSection: some View {
        VStack(spacing: VSpacing.md) {
            recentConversationsWidget
            if !viewModel.reminders.isEmpty {
                remindersWidget
            }
        }
    }

    // MARK: - Recent Conversations Widget

    private var recentConversationsWidget: some View {
        VStack(spacing: 0) {
            sectionHeader(icon: "bubble.left.and.bubble.right", title: "Recent Conversations")

            if viewModel.recentSessions.isEmpty && !viewModel.isLoadingWidgets {
                HStack {
                    Text("No recent conversations")
                        .font(VFont.body)
                        .foregroundColor(VColor.textMuted)
                    Spacer()
                }
                .padding(VSpacing.lg)
            } else if viewModel.isLoadingWidgets && viewModel.recentSessions.isEmpty {
                HStack {
                    ProgressView()
                        .padding(.trailing, VSpacing.xs)
                    Text("Loading…")
                        .font(VFont.body)
                        .foregroundColor(VColor.textMuted)
                    Spacer()
                }
                .padding(VSpacing.lg)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(viewModel.recentSessions.enumerated()), id: \.element.id) { index, session in
                        conversationRow(session, isLast: index == viewModel.recentSessions.count - 1)
                    }
                }
            }
        }
        .background(VColor.surface)
        .cornerRadius(VRadius.lg)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Recent Conversations")
    }

    private func conversationRow(_ session: IPCSessionListResponseSession, isLast: Bool) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "bubble.left")
                    .font(.system(size: 13))
                    .foregroundColor(VColor.textMuted)
                    .accessibilityHidden(true)

                Text(session.title)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)

                Spacer()

                Text(relativeDate(epochMs: session.updatedAt))
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)

            if !isLast {
                Divider()
                    .padding(.leading, VSpacing.lg + 13 + VSpacing.sm)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Conversation: \(session.title)")
    }

    // MARK: - Reminders Widget

    private var remindersWidget: some View {
        VStack(spacing: 0) {
            sectionHeader(icon: "bell.fill", title: "Upcoming Reminders")

            VStack(spacing: 0) {
                ForEach(Array(viewModel.reminders.enumerated()), id: \.element.id) { index, reminder in
                    reminderRow(reminder, isLast: index == viewModel.reminders.count - 1)
                }
            }
        }
        .background(VColor.surface)
        .cornerRadius(VRadius.lg)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Upcoming Reminders")
    }

    private func reminderRow(_ reminder: ReminderItem, isLast: Bool) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "bell")
                    .font(.system(size: 13))
                    .foregroundColor(VColor.warning)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text(reminder.label)
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textPrimary)
                        .lineLimit(1)

                    Text(reminder.message)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .lineLimit(1)
                }

                Spacer()

                Text(relativeDate(epochMs: reminder.fireAt))
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)

            if !isLast {
                Divider()
                    .padding(.leading, VSpacing.lg + 13 + VSpacing.sm)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Reminder: \(reminder.label), due \(relativeDate(epochMs: reminder.fireAt))")
    }

    // MARK: - Pinned App Links

    private var pinnedAppsSection: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "pin.fill")
                    .foregroundColor(VColor.accent)
                    .accessibilityHidden(true)
                Text("Pinned Apps")
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                Button {
                    newPinName = ""
                    newPinURL = ""
                    newPinIcon = ""
                    showAddPinSheet = true
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(VColor.accent)
                }
                .accessibilityLabel("Add Pinned App")
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
            .background(VColor.backgroundSubtle)

            if pinnedAppsStore.pins.isEmpty {
                HStack {
                    Text("No pinned apps yet. Tap + to add one.")
                        .font(VFont.body)
                        .foregroundColor(VColor.textMuted)
                    Spacer()
                }
                .padding(VSpacing.lg)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: VSpacing.md) {
                        ForEach(pinnedAppsStore.pins) { pin in
                            pinnedAppCard(pin)
                        }
                    }
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.md)
                }
            }
        }
        .background(VColor.surface)
        .cornerRadius(VRadius.lg)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Pinned Apps")
        .sheet(isPresented: $showAddPinSheet) {
            addPinSheet
        }
    }

    private var addPinSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("App name", text: $newPinName)
                        .autocorrectionDisabled()
                    TextField("URL (e.g. https://example.com)", text: $newPinURL)
                        .keyboardType(.URL)
                        .autocapitalization(.none)
                        .autocorrectionDisabled()
                    TextField("Icon emoji (optional)", text: $newPinIcon)
                }
            }
            .navigationTitle("Add Pinned App")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showAddPinSheet = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        let trimmedName = newPinName.trimmingCharacters(in: .whitespaces)
                        let trimmedURL = newPinURL.trimmingCharacters(in: .whitespaces)
                        guard !trimmedName.isEmpty, !trimmedURL.isEmpty, URL(string: trimmedURL) != nil else { return }
                        pinnedAppsStore.pin(PinnedAppLink(
                            id: UUID().uuidString,
                            name: trimmedName,
                            icon: newPinIcon.isEmpty ? nil : newPinIcon,
                            url: trimmedURL,
                            appType: nil,
                            pinnedOrder: pinnedAppsStore.pins.count
                        ))
                        showAddPinSheet = false
                    }
                    .disabled({
                        let trimmedName = newPinName.trimmingCharacters(in: .whitespaces)
                        let trimmedURL = newPinURL.trimmingCharacters(in: .whitespaces)
                        return trimmedName.isEmpty || trimmedURL.isEmpty || URL(string: trimmedURL) == nil
                    }())
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func pinnedAppCard(_ pin: PinnedAppLink) -> some View {
        Button {
            // Open the pinned URL in Safari if available; otherwise no-op.
            if let urlString = pin.url, !urlString.isEmpty, let url = URL(string: urlString) {
                UIApplication.shared.open(url)
            }
        } label: {
            VStack(spacing: VSpacing.xs) {
                ZStack {
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(VColor.backgroundSubtle)
                        .frame(width: 56, height: 56)

                    if let icon = pin.icon, !icon.isEmpty {
                        Text(icon)
                            .font(.system(size: 28))
                    } else {
                        Image(systemName: "square.fill")
                            .font(.system(size: 24))
                            .foregroundColor(VColor.textMuted)
                    }
                }

                Text(pin.name)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)
                    .frame(width: 64)
            }
            .frame(width: 72)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Pinned app: \(pin.name)")
        .contextMenu {
            if let urlString = pin.url, !urlString.isEmpty, let url = URL(string: urlString) {
                Button {
                    UIApplication.shared.open(url)
                } label: {
                    Label("Open", systemImage: "arrow.up.right.square")
                }
            }
            Button(role: .destructive) {
                withAnimation(VAnimation.standard) {
                    pinnedAppsStore.unpin(id: pin.id)
                }
            } label: {
                Label("Unpin", systemImage: "pin.slash")
            }
        }
    }

    // MARK: - App Preview Card

    private func appPreviewCard(_ preview: IPCHomeBaseGetResponseHomeBasePreview) -> some View {
        VStack(spacing: VSpacing.md) {
            Text(preview.icon)
                .font(.system(size: 56))
                .accessibilityHidden(true)

            Text(preview.title)
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)
                .multilineTextAlignment(.center)

            if !preview.subtitle.isEmpty {
                Text(preview.subtitle)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
            }

            if !preview.description.isEmpty {
                Text(preview.description)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, VSpacing.md)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.lg)
        .background(VColor.surface)
        .cornerRadius(VRadius.lg)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(preview.title), \(preview.subtitle)")
    }

    // MARK: - Metrics Section

    private func metricsSection(_ metrics: [IPCHomeBaseGetResponseHomeBasePreviewMetric]) -> some View {
        VStack(spacing: 0) {
            sectionHeader(icon: "chart.bar.fill", title: "Metrics")

            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
            ], spacing: VSpacing.sm) {
                ForEach(Array(metrics.enumerated()), id: \.offset) { _, metric in
                    metricCard(metric)
                }
            }
            .padding(VSpacing.lg)
        }
        .background(VColor.surface)
        .cornerRadius(VRadius.lg)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Metrics")
    }

    private func metricCard(_ metric: IPCHomeBaseGetResponseHomeBasePreviewMetric) -> some View {
        VStack(spacing: 4) {
            Text(metric.value)
                .font(VFont.title)
                .foregroundColor(VColor.accent)

            Text(metric.label)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.backgroundSubtle)
        .cornerRadius(VRadius.md)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(metric.label): \(metric.value)")
    }

    // MARK: - Task List Section

    private func taskListSection(icon: String, title: String, tasks: [String]) -> some View {
        VStack(spacing: 0) {
            sectionHeader(icon: icon, title: title)

            VStack(spacing: 0) {
                ForEach(Array(tasks.enumerated()), id: \.offset) { index, task in
                    taskRow(task, isLast: index == tasks.count - 1)
                }
            }
        }
        .background(VColor.surface)
        .cornerRadius(VRadius.lg)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }

    private func taskRow(_ task: String, isLast: Bool) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "circle")
                    .font(.system(size: 14))
                    .foregroundColor(VColor.textMuted)
                    .accessibilityHidden(true)

                Text(task)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)

                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)

            if !isLast {
                Divider()
                    .padding(.leading, VSpacing.lg + 14 + VSpacing.sm)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Task: \(task)")
    }

    // MARK: - Shared Section Header

    private func sectionHeader(icon: String, title: String) -> some View {
        HStack {
            Image(systemName: icon)
                .foregroundColor(VColor.accent)
                .accessibilityHidden(true)
            Text(title)
                .font(VFont.headline)
                .foregroundColor(VColor.textPrimary)
            Spacer()
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(VColor.backgroundSubtle)
    }

    // MARK: - Empty States

    private var disconnectedState: some View {
        VStack(spacing: VSpacing.lg) {
            Image(systemName: "desktopcomputer")
                .font(.system(size: 48))
                .foregroundColor(VColor.textMuted)
                .accessibilityHidden(true)

            Text("Connect to Your Mac")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Text("Home Base is available when connected to your assistant on Mac.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)

            if onConnectTapped != nil {
                Button {
                    onConnectTapped?()
                } label: {
                    Text("Go to Settings")
                }
                .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var loadingState: some View {
        VStack(spacing: VSpacing.md) {
            ProgressView()
            Text("Loading Home Base...")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Helpers

    private func relativeDate(epochMs: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(epochMs) / 1000.0)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

#Preview {
    HomeBaseView()
        .environmentObject(ClientProvider(client: DaemonClient(config: .default)))
}
#endif
