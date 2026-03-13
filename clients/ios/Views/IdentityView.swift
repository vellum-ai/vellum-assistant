#if canImport(UIKit)
import Combine
import SwiftUI
import VellumAssistantShared

// MARK: - ViewModel

@MainActor @Observable
final class IdentityViewModel {
    var identity: RemoteIdentityInfo?
    var isLoading = false

    var skillsStore: SkillsStore?
    var contactsStore: ContactsStore?
    var memoriesStore: MemoryItemsStore?

    // Cached counts — updated via Combine when the stores' @Published properties change.
    var installedSkillsCount: Int = 0
    var contactsCount: Int = 0
    var memoriesCount: Int = 0

    private var cancellables: Set<AnyCancellable> = []

    func setUp(daemonClient: DaemonClient) {
        cancellables.removeAll()

        let skills = SkillsStore(daemonClient: daemonClient)
        skillsStore = skills
        let contacts = ContactsStore(daemonClient: daemonClient)
        contactsStore = contacts

        skills.$skills
            .map(\.count)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] count in self?.installedSkillsCount = count }
            .store(in: &cancellables)

        contacts.$contacts
            .map(\.count)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] count in self?.contactsCount = count }
            .store(in: &cancellables)

        let memories = MemoryItemsStore(daemonClient: daemonClient)
        memoriesStore = memories
        memories.$items
            .map(\.count)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] count in self?.memoriesCount = count }
            .store(in: &cancellables)

        skills.fetchSkills(force: true)
        contacts.loadContacts()
        Task { await memories.loadItems() }
    }

    func tearDown() {
        cancellables.removeAll()
        skillsStore = nil
        contactsStore = nil
        memoriesStore = nil
        installedSkillsCount = 0
        contactsCount = 0
        memoriesCount = 0
    }

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
        .task(id: "\(clientProvider.clientGeneration)-\(clientProvider.isConnected)") {
            guard clientProvider.isConnected else {
                viewModel.tearDown()
                return
            }
            if let daemonClient = clientProvider.client as? DaemonClient {
                viewModel.setUp(daemonClient: daemonClient)
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
                    if let store = viewModel.skillsStore {
                        InstalledSkillsView(skillsStore: store)
                    }
                } label: {
                    HStack(spacing: VSpacing.sm) {
                        VIconView(.brain, size: 16)
                            .foregroundColor(VColor.primaryBase)
                            .frame(width: 24)
                        Text("Installed Skills")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                        Spacer()
                        if viewModel.installedSkillsCount > 0 {
                            Text("\(viewModel.installedSkillsCount)")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 2)
                                .background(
                                    Capsule()
                                        .fill(VColor.borderBase)
                                )
                        }
                    }
                }
                .disabled(viewModel.skillsStore == nil)

                // Community Skills
                NavigationLink {
                    if let store = viewModel.skillsStore {
                        CommunitySkillsView(skillsStore: store)
                    }
                } label: {
                    HStack(spacing: VSpacing.sm) {
                        VIconView(.globe, size: 16)
                            .foregroundColor(VColor.primaryBase)
                            .frame(width: 24)
                        Text("Community Skills")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                    }
                }
                .disabled(viewModel.skillsStore == nil)

                // Contacts
                NavigationLink {
                    if let store = viewModel.contactsStore {
                        ContactsListView(contactsStore: store)
                    }
                } label: {
                    HStack(spacing: VSpacing.sm) {
                        VIconView(.users, size: 16)
                            .foregroundColor(VColor.primaryBase)
                            .frame(width: 24)
                        Text("Contacts")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                        Spacer()
                        if viewModel.contactsCount > 0 {
                            Text("\(viewModel.contactsCount)")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 2)
                                .background(
                                    Capsule()
                                        .fill(VColor.borderBase)
                                )
                        }
                    }
                }
                .disabled(viewModel.contactsStore == nil)

                // Memories
                NavigationLink {
                    if let store = viewModel.memoriesStore {
                        MemoriesListView(store: store)
                    }
                } label: {
                    HStack(spacing: VSpacing.sm) {
                        VIconView(.bookOpen, size: 16)
                            .foregroundColor(VColor.primaryBase)
                            .frame(width: 24)
                        Text("Memories")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                        Spacer()
                        if viewModel.memoriesCount > 0 {
                            Text("\(viewModel.memoriesCount)")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 2)
                                .background(
                                    Capsule()
                                        .fill(VColor.borderBase)
                                )
                        }
                    }
                }
                .disabled(viewModel.memoriesStore == nil)
            }

            // Workspace section
            Section {
                NavigationLink {
                    WorkspaceBrowserView(client: clientProvider.client as? DaemonClient)
                } label: {
                    HStack(spacing: VSpacing.sm) {
                        VIconView(.folder, size: 16)
                            .foregroundColor(VColor.primaryBase)
                            .frame(width: 24)
                        Text("Browse Workspace")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                    }
                }
            }
        }
        .refreshable {
            viewModel.skillsStore?.fetchSkills(force: true)
            viewModel.contactsStore?.loadContacts()
            if let memoriesStore = viewModel.memoriesStore {
                await memoriesStore.loadItems()
            }
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
                        .foregroundColor(VColor.contentDefault)
                }
                if !identity.role.isEmpty {
                    Text(identity.role)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
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
                .foregroundColor(VColor.contentTertiary)
                .accessibilityHidden(true)

            Text("Connect to your Assistant")
                .font(VFont.title)
                .foregroundColor(VColor.contentDefault)

            Text("Intelligence information is available when connected to your Assistant.")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
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
                .foregroundColor(VColor.contentSecondary)
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
