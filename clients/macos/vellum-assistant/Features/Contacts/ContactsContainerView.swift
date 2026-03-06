import SwiftUI
import VellumAssistantShared

/// Master-detail container for the Contacts tab in Settings.
/// Left pane shows the contacts list; right pane shows detail for the
/// selected contact, or a placeholder when nothing is selected.
@MainActor
struct ContactsContainerView: View {
    var daemonClient: DaemonClient?
    var store: SettingsStore?

    @StateObject private var viewModel: ContactsViewModel
    @State private var selectedContactId: String?

    init(daemonClient: DaemonClient?, store: SettingsStore? = nil) {
        self.daemonClient = daemonClient
        self.store = store
        _viewModel = StateObject(wrappedValue: ContactsViewModel(daemonClient: daemonClient))
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            // Left pane: contacts list
            ScrollView {
                ContactsListView(
                    viewModel: viewModel,
                    selectedContactId: $selectedContactId
                )
                .padding(VSpacing.lg)
            }
            .frame(width: 320)
            .background(VColor.background)

            Divider()
                .background(VColor.surfaceBorder)

            // Right pane: detail, loading, or placeholder
            if viewModel.isLoading && viewModel.contacts.isEmpty {
                // Loading state — contacts are being fetched
                VStack(spacing: VSpacing.md) {
                    ProgressView()
                        .controlSize(.regular)
                    Text("Loading contacts...")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(VColor.background)
            } else if let contactId = selectedContactId,
                      let contact = viewModel.contacts.first(where: { $0.id == contactId }) {
                ContactDetailView(
                    contact: contact,
                    daemonClient: daemonClient,
                    store: store,
                    onDelete: {
                        selectedContactId = nil
                        viewModel.loadContacts()
                    }
                )
                .id(contactId)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            } else {
                // True empty state — contacts loaded but none selected
                VStack(spacing: VSpacing.md) {
                    Image(systemName: "person.2.fill")
                        .font(.system(size: 36))
                        .foregroundColor(VColor.textMuted)
                    Text("Select a contact")
                        .font(VFont.headline)
                        .foregroundColor(VColor.textSecondary)
                    Text("Choose a contact from the list to view their details.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 240)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(VColor.background)
            }
        }
        .onReceive(viewModel.$contacts) { newContacts in
            if selectedContactId == nil,
               let guardian = newContacts.first(where: { $0.role == "guardian" }) {
                selectedContactId = guardian.id
            }
        }
        .sheet(isPresented: $viewModel.isCreatingContact) {
            ContactCreateView(
                daemonClient: daemonClient,
                isPresented: $viewModel.isCreatingContact,
                onCreated: { contact in
                    selectedContactId = contact.id
                    viewModel.loadContacts()
                }
            )
        }
    }
}
