import SwiftUI
import VellumAssistantShared

/// Selection model for the Contacts tab — either the assistant's channel
/// configuration or a specific contact.
enum ContactSelection: Hashable {
    case assistant
    case contact(String)
}

/// Master-detail container for the Contacts tab in Settings.
/// Left pane shows the contacts list; right pane shows detail for the
/// selected contact, the assistant channel configuration, or a placeholder.
@MainActor
struct ContactsContainerView: View {
    var daemonClient: DaemonClient?
    var store: SettingsStore?
    var isEmailEnabled: Bool = false

    @StateObject private var viewModel: ContactsViewModel
    @State private var selection: ContactSelection? = .assistant

    private let contactClient: ContactClientProtocol = ContactClient()

    init(daemonClient: DaemonClient?, store: SettingsStore? = nil, isEmailEnabled: Bool = false) {
        self.daemonClient = daemonClient
        self.store = store
        self.isEmailEnabled = isEmailEnabled
        _viewModel = StateObject(wrappedValue: ContactsViewModel(daemonClient: daemonClient))
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            // Left pane: contacts list (full height, internal scrolling)
            ContactsListView(
                viewModel: viewModel,
                selection: $selection
            )
            .padding(VSpacing.lg)
            .frame(width: 320)
            .frame(maxHeight: .infinity, alignment: .top)
            .background(VColor.surfaceOverlay)

            // Right pane: detail, loading, or placeholder
            if viewModel.isLoading && viewModel.contacts.isEmpty {
                // Loading state — contacts are being fetched
                VStack(spacing: VSpacing.md) {
                    ProgressView()
                        .controlSize(.regular)
                    Text("Loading contacts...")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(VColor.surfaceOverlay)
            } else {
                switch selection {
                case .assistant:
                    assistantDetailView
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                case .contact(let contactId):
                    if let contact = viewModel.contacts.first(where: { $0.id == contactId }) {
                        if contact.role == "guardian" {
                            guardianDetailView(contact: contact)
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        } else {
                            ContactDetailView(
                                contact: contact,
                                daemonClient: daemonClient,
                                store: store,
                                onDelete: {
                                    selection = .assistant
                                    viewModel.loadContacts()
                                },
                                guardianName: viewModel.guardianContact?.displayName
                            )
                            .id(contactId)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        }
                    }
                case nil:
                    // True empty state — contacts loaded but none selected
                    VStack(spacing: VSpacing.md) {
                        VIconView(.users, size: 36)
                            .foregroundColor(VColor.contentTertiary)
                        Text("Select a contact")
                            .font(VFont.headline)
                            .foregroundColor(VColor.contentSecondary)
                        Text("Choose a contact from the list to view their details.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 240)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(VColor.surfaceOverlay)
                }
            }
        }
        .onReceive(viewModel.$contacts) { newContacts in
            // Default to assistant on first load (don't override existing selection)
            if selection == nil && !newContacts.isEmpty {
                selection = .assistant
            }
        }
        .onChange(of: viewModel.isCreatingContact) { _, isCreating in
            if isCreating {
                Task {
                    await createPlaceholderContact()
                }
            }
        }
    }

    @State private var cachedAssistantName: String = AssistantDisplayName.placeholder

    /// Guardian detail — name+tag header card, then existing channel content in a second card.
    private func guardianDetailView(contact: ContactPayload) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(spacing: VSpacing.sm) {
                        Text(contact.displayName)
                            .font(VFont.display)
                            .foregroundColor(VColor.contentDefault)
                        VBadge(label: "Guardian", tone: .neutral)
                    }
                    Text("\(contact.interactionCount) interaction\(contact.interactionCount == 1 ? "" : "s")")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.lg)
                .vCard(radius: VRadius.lg, background: VColor.surfaceOverlay)

                GuardianChannelsDetailView(
                    contact: contact,
                    daemonClient: daemonClient,
                    store: store,
                    onSelectAssistant: { selection = .assistant },
                    showCardBorders: false
                )
                .padding(VSpacing.lg)
                .vCard(radius: VRadius.lg, background: VColor.surfaceOverlay)
            }
            .padding(VSpacing.lg)
        }
        .background(VColor.surfaceOverlay)
        .id(contact.id)
    }

    /// Assistant detail with the same card header as human contacts, plus
    /// the existing AssistantChannelsDetailView for channel configuration.
    @ViewBuilder
    private var assistantDetailView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    HStack(spacing: VSpacing.sm) {
                        Text(cachedAssistantName)
                            .font(VFont.display)
                            .foregroundColor(VColor.contentDefault)
                        VBadge(label: "Assistant", tone: .neutral)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.lg)
                .vCard(radius: VRadius.lg, background: VColor.surfaceOverlay)

                if let store {
                    AssistantChannelsDetailView(store: store, daemonClient: daemonClient, isEmailEnabled: isEmailEnabled, showCardBorders: false)
                        .padding(VSpacing.lg)
                        .vCard(radius: VRadius.lg, background: VColor.surfaceOverlay)
                }
            }
            .padding(VSpacing.lg)
        }
        .background(VColor.surfaceOverlay)
        .task {
            cachedAssistantName = AssistantDisplayName.firstUserFacing(from: [IdentityInfo.load()?.name]) ?? AssistantDisplayName.placeholder
        }
    }

    /// Creates a placeholder contact with a default name, selects it in the
    /// list, and shows the detail pane so the user can edit inline.
    private func createPlaceholderContact() async {
        viewModel.isCreatingContact = false
        do {
            let contact = try await contactClient.createContact(
                displayName: "New Contact",
                notes: nil,
                channels: nil
            )
            if let contact {
                viewModel.loadContacts()
                // Small delay to let the contacts list refresh before selecting
                try? await Task.sleep(nanoseconds: 200_000_000)
                selection = .contact(contact.id)
            }
        } catch {
            // Silently fail — user can retry via the + button
        }
    }
}
