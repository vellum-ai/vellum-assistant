#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// MARK: - ViewModel

@MainActor @Observable
final class HomeBaseViewModel {
    var response: HomeBaseGetResponseMessage?
    var isLoading = false

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
}

// MARK: - View

struct HomeBaseView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @State private var viewModel = HomeBaseViewModel()

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
                    noHomeBaseState
                }
            }
            .navigationTitle("Home")
        }
        .task {
            if clientProvider.isConnected {
                await viewModel.fetch(client: clientProvider.client)
            }
        }
        .onChange(of: clientProvider.isConnected) { _, connected in
            if connected {
                Task {
                    await viewModel.fetch(client: clientProvider.client)
                }
            }
        }
    }

    // MARK: - Dashboard Content

    private func dashboardContent(_ homeBase: IPCHomeBaseGetResponseHomeBase) -> some View {
        ScrollView {
            VStack(spacing: VSpacing.lg) {
                appPreviewCard(homeBase.preview)

                if !homeBase.preview.metrics.isEmpty {
                    metricsSection(homeBase.preview.metrics)
                }

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
            .padding(.horizontal, VSpacing.lg)
            .padding(.top, VSpacing.md)
        }
        .refreshable {
            await viewModel.fetch(client: clientProvider.client)
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

    private var noHomeBaseState: some View {
        VStack(spacing: VSpacing.lg) {
            Image(systemName: "house")
                .font(.system(size: 48))
                .foregroundColor(VColor.textMuted)
                .accessibilityHidden(true)

            Text("No Home Base")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Text("Your assistant doesn't have a Home Base configured yet.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview {
    HomeBaseView()
        .environmentObject(ClientProvider(client: DaemonClient(config: .default)))
}
#endif
