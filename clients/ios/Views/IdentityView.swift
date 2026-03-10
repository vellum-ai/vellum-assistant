#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// MARK: - ViewModel

@MainActor @Observable
final class IdentityViewModel {
    var identity: RemoteIdentityInfo?
    var isLoading = false

    func fetchIdentity(client: any DaemonClientProtocol) async {
        guard let daemonClient = client as? DaemonClient else { return }
        isLoading = true
        identity = await daemonClient.fetchRemoteIdentity()
        isLoading = false
    }
}

// MARK: - View

struct IdentityView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @State private var viewModel = IdentityViewModel()
    @State private var skillsStore: SkillsStore?
    @State private var contactsStore: ContactsStore?
    var onConnectTapped: (() -> Void)?

    var body: some View {
        NavigationStack {
            Group {
                if !clientProvider.isConnected {
                    disconnectedState
                } else if viewModel.isLoading && viewModel.identity == nil {
                    loadingState
                } else {
                    intelligenceContent
                }
            }
            .navigationTitle("Intelligence")
        }
        .task(id: clientProvider.clientGeneration) {
            guard clientProvider.isConnected else { return }
            if let daemonClient = clientProvider.client as? DaemonClient {
                let skills = SkillsStore(daemonClient: daemonClient)
                skillsStore = skills
                let contacts = ContactsStore(daemonClient: daemonClient)
                contactsStore = contacts
                skills.fetchSkills(force: true)
                contacts.loadContacts()
            }
            await viewModel.fetchIdentity(client: clientProvider.client)
        }
    }

    // MARK: - Intelligence Content

    private var intelligenceContent: some View {
        List {
            // Identity card section
            if let identity = viewModel.identity {
                Section {
                    identityCardRow(identity)
                }
            }

            // Navigation section
            Section {
                // Installed Skills
                NavigationLink {
                    if let store = skillsStore {
                        InstalledSkillsView(skillsStore: store)
                    }
                } label: {
                    HStack(spacing: VSpacing.sm) {
                        VIconView(.brain, size: 16)
                            .foregroundColor(VColor.accent)
                            .frame(width: 24)
                        Text("Installed Skills")
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                        Spacer()
                        if let count = skillsStore?.skills.count, count > 0 {
                            Text("\(count)")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 2)
                                .background(
                                    Capsule()
                                        .fill(VColor.surfaceBorder)
                                )
                        }
                    }
                }
                .disabled(skillsStore == nil)

                // Community Skills
                NavigationLink {
                    if let store = skillsStore {
                        CommunitySkillsView(skillsStore: store)
                    }
                } label: {
                    HStack(spacing: VSpacing.sm) {
                        VIconView(.globe, size: 16)
                            .foregroundColor(VColor.accent)
                            .frame(width: 24)
                        Text("Community Skills")
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                    }
                }
                .disabled(skillsStore == nil)

                // Contacts
                NavigationLink {
                    if let store = contactsStore {
                        ContactsListView(contactsStore: store)
                    }
                } label: {
                    HStack(spacing: VSpacing.sm) {
                        VIconView(.users, size: 16)
                            .foregroundColor(VColor.accent)
                            .frame(width: 24)
                        Text("Contacts")
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                        Spacer()
                        if let count = contactsStore?.contacts.count, count > 0 {
                            Text("\(count)")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 2)
                                .background(
                                    Capsule()
                                        .fill(VColor.surfaceBorder)
                                )
                        }
                    }
                }
                .disabled(contactsStore == nil)
            }

            // Workspace section
            Section {
                NavigationLink {
                    WorkspaceBrowserView(client: clientProvider.client as? DaemonClient)
                } label: {
                    HStack(spacing: VSpacing.sm) {
                        VIconView(.folder, size: 16)
                            .foregroundColor(VColor.accent)
                            .frame(width: 24)
                        Text("Browse Workspace")
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                    }
                }
            }
        }
        .refreshable {
            skillsStore?.fetchSkills(force: true)
            contactsStore?.loadContacts()
            await viewModel.fetchIdentity(client: clientProvider.client)
        }
    }

    // MARK: - Identity Card Row

    private func identityCardRow(_ identity: RemoteIdentityInfo) -> some View {
        HStack(spacing: VSpacing.md) {
            Text(identity.emoji)
                .font(.system(size: 40))
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                if !identity.name.isEmpty {
                    Text(identity.name)
                        .font(VFont.headline)
                        .foregroundColor(VColor.textPrimary)
                }
                if !identity.role.isEmpty {
                    Text(identity.role)
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
            }

            Spacer()
        }
        .padding(.vertical, VSpacing.xs)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Identity: \(identity.name), \(identity.role)")
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

            Text("Intelligence information is available when connected to your Assistant.")
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
            Text("Loading...")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
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
