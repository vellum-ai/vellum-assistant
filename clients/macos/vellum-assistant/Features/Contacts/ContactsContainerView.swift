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
                    if let store {
                        AssistantChannelsDetailView(store: store, daemonClient: daemonClient, isEmailEnabled: isEmailEnabled)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    } else {
                        VStack(spacing: VSpacing.md) {
                            ProgressView()
                                .controlSize(.regular)
                            Text("Loading assistant channels...")
                                .font(VFont.body)
                                .foregroundColor(VColor.contentSecondary)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(VColor.surfaceOverlay)
                    }
                case .contact(let contactId):
                    if let contact = viewModel.contacts.first(where: { $0.id == contactId }) {
                        if contact.role == "guardian" {
                            GuardianChannelsDetailView(
                                contact: contact,
                                daemonClient: daemonClient,
                                store: store,
                                onSelectAssistant: { selection = .assistant }
                            )
                            .id(contactId)
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
        .sheet(isPresented: $viewModel.isCreatingContact) {
            ContactCreateView(
                daemonClient: daemonClient,
                isPresented: $viewModel.isCreatingContact,
                onCreated: { contact in
                    selection = .contact(contact.id)
                    viewModel.loadContacts()
                }
            )
        }
    }
}
