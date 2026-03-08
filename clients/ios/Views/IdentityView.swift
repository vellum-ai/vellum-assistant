#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// MARK: - ViewModel

@MainActor @Observable
final class IdentityViewModel {
    var identity: RemoteIdentityInfo?
    var skills: [SkillInfo] = []
    var isLoading = false

    func fetchAll(client: any DaemonClientProtocol) async {
        guard let daemonClient = client as? DaemonClient else { return }
        isLoading = true
        async let identityResult = daemonClient.fetchRemoteIdentity()
        identity = await identityResult
        isLoading = false

        // Fetch skills via IPC (fire-and-forget subscribe)
        await fetchSkills(daemonClient: daemonClient)
    }

    private func fetchSkills(daemonClient: DaemonClient) async {
        let stream = daemonClient.subscribe()
        do {
            try daemonClient.send(SkillsListRequestMessage())
        } catch {
            return
        }

        let response: SkillsListResponseMessage? = await withTaskGroup(of: SkillsListResponseMessage?.self) { group in
            group.addTask {
                for await message in stream {
                    if case .skillsListResponse(let msg) = message {
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

        if let response {
            skills = response.skills.filter { $0.state == "enabled" }
        }
    }
}

// MARK: - View

struct IdentityView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @State private var viewModel = IdentityViewModel()
    var onConnectTapped: (() -> Void)?

    var body: some View {
        NavigationStack {
            Group {
                if !clientProvider.isConnected {
                    disconnectedState
                } else if viewModel.isLoading && viewModel.identity == nil {
                    loadingState
                } else if let identity = viewModel.identity {
                    idCardContent(identity)
                } else {
                    noIdentityState
                }
            }
            .navigationTitle("Identity")
        }
        .task(id: clientProvider.isConnected) {
            guard clientProvider.isConnected else { return }
            await viewModel.fetchAll(client: clientProvider.client)
        }
    }

    // MARK: - ID Card Content

    private func idCardContent(_ identity: RemoteIdentityInfo) -> some View {
        ScrollView {
            VStack(spacing: VSpacing.lg) {
                avatarSection(identity)
                idCard(identity)

                if !viewModel.skills.isEmpty {
                    skillsSection
                }

                workspaceFilesSection
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.top, VSpacing.md)
        }
        .refreshable {
            await viewModel.fetchAll(client: clientProvider.client)
        }
    }

    private func avatarSection(_ identity: RemoteIdentityInfo) -> some View {
        VStack(spacing: VSpacing.sm) {
            Text(identity.emoji)
                .font(.system(size: 64))
                .accessibilityHidden(true)

            if !identity.name.isEmpty {
                Text(identity.name)
                    .font(VFont.title)
                    .foregroundColor(VColor.textPrimary)
            }

            if !identity.role.isEmpty {
                Text(identity.role)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.lg)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Avatar: \(identity.name), \(identity.role)")
    }

    // MARK: - ID Card

    private func idCard(_ identity: RemoteIdentityInfo) -> some View {
        let rows = buildCardRows(identity)

        return VStack(spacing: 0) {
            sectionHeader(icon: .contact, title: "ID Card")

            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    idCardRow(label: row.label, value: row.value, isLast: index == rows.count - 1)
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
        .accessibilityLabel("Identity card")
    }

    private struct CardRow {
        let label: String
        let value: String
    }

    private func buildCardRows(_ identity: RemoteIdentityInfo) -> [CardRow] {
        var rows: [CardRow] = []
        if let assistantId = identity.assistantId, !assistantId.isEmpty {
            rows.append(CardRow(label: "Assistant ID", value: assistantId))
        }
        if !identity.name.isEmpty {
            rows.append(CardRow(label: "Name", value: identity.name))
        }
        if !identity.role.isEmpty {
            rows.append(CardRow(label: "Role", value: identity.role))
        }
        if !identity.personality.isEmpty {
            rows.append(CardRow(label: "Personality", value: identity.personality))
        }
        if let version = identity.version, !version.isEmpty {
            rows.append(CardRow(label: "Version", value: version))
        }
        if let createdAt = identity.createdAt, !createdAt.isEmpty {
            rows.append(CardRow(label: "Created", value: formatDate(createdAt)))
        }
        if let originSystem = identity.originSystem, !originSystem.isEmpty {
            rows.append(CardRow(label: "Origin", value: originSystem.capitalized))
        }
        if let home = identity.home, !home.isEmpty {
            rows.append(CardRow(label: "Home", value: home))
        }
        return rows
    }

    // MARK: - Skills Section

    private var skillsSection: some View {
        VStack(spacing: 0) {
            sectionHeader(icon: .star, title: "Skills")

            VStack(spacing: 0) {
                ForEach(Array(viewModel.skills.enumerated()), id: \.element.id) { index, skill in
                    skillRow(skill, isLast: index == viewModel.skills.count - 1)
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
        .accessibilityLabel("Skills list")
    }

    private func skillRow(_ skill: SkillInfo, isLast: Bool) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: VSpacing.sm) {
                Text(skill.emoji ?? "")
                    .font(.system(size: 20))
                    .frame(width: 28)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(skill.name)
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)

                        if let provenance = skill.provenance {
                            let label = provenance.kind == "first-party" ? (provenance.provider ?? "Vellum") : provenance.kind == "local" ? "Local" : (provenance.provider ?? "Third-party")
                            let badgeColor: Color = provenance.kind == "first-party" ? .blue : provenance.kind == "local" ? .secondary : .orange
                            Text(label)
                                .font(.caption2)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(
                                    Capsule()
                                        .fill(badgeColor.opacity(0.15))
                                )
                                .foregroundColor(badgeColor)
                        }
                    }

                    if !skill.description.isEmpty {
                        Text(skill.description)
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                            .lineLimit(1)
                    }
                }

                Spacer()

                if skill.degraded {
                    VIconView(.triangleAlert, size: 12)
                        .foregroundColor(.orange)
                        .accessibilityLabel("Degraded")
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)

            if !isLast {
                Divider()
                    .padding(.leading, VSpacing.lg + 28 + VSpacing.sm)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Skill: \(skill.name), enabled\(skill.degraded ? ", degraded" : "")")
    }

    // MARK: - Workspace Files Section

    private var workspaceFilesSection: some View {
        VStack(spacing: 0) {
            sectionHeader(icon: .fileText, title: "Workspace")

            NavigationLink {
                WorkspaceBrowserView(client: clientProvider.client as? DaemonClient)
            } label: {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.folder, size: 16)
                        .foregroundColor(VColor.accent)
                        .frame(width: 24)
                        .accessibilityHidden(true)

                    Text("Browse Workspace")
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)

                    Spacer()

                    VIconView(.chevronRight, size: 12)
                        .foregroundColor(VColor.textMuted)
                        .accessibilityHidden(true)
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.sm)
            }
        }
        .background(VColor.surface)
        .cornerRadius(VRadius.lg)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
    }

    // MARK: - Shared Section Header

    private func sectionHeader(icon: VIcon, title: String) -> some View {
        HStack {
            VIconView(icon, size: 16)
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

    private func idCardRow(label: String, value: String, isLast: Bool = false) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text(label)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .frame(width: 90, alignment: .leading)

                Text(value)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)

                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)

            if !isLast {
                Divider()
                    .padding(.leading, VSpacing.lg)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }

    // MARK: - Empty States

    private var disconnectedState: some View {
        VStack(spacing: VSpacing.lg) {
            VIconView(.monitor, size: 48)
                .foregroundColor(VColor.textMuted)
                .accessibilityHidden(true)

            Text("Connect to your Assistant")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Text("Identity information is available when connected to your Assistant.")
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
            Text("Loading identity...")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var noIdentityState: some View {
        VStack(spacing: VSpacing.lg) {
            VIconView(.circleUser, size: 48)
                .foregroundColor(VColor.textMuted)
                .accessibilityHidden(true)

            Text("No Identity Found")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Text("Your assistant doesn't have an IDENTITY.md file yet.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Helpers

    private func formatDate(_ isoString: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: isoString) {
            return formatDisplayDate(date)
        }
        // Try without fractional seconds
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: isoString) {
            return formatDisplayDate(date)
        }
        return isoString
    }

    private func formatDisplayDate(_ date: Date) -> String {
        let display = DateFormatter()
        display.dateStyle = .medium
        display.timeStyle = .none
        return display.string(from: date)
    }
}

#Preview {
    IdentityView()
        .environmentObject(ClientProvider(client: DaemonClient(config: .default)))
}
#endif
