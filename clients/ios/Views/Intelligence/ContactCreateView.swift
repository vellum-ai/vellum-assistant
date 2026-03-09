#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct ContactCreateView: View {
    @ObservedObject var contactsStore: ContactsStore
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var notes = ""

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Contact Info") {
                    TextField("Name", text: $name)
                        .font(VFont.body)

                    TextField("Notes (optional)", text: $notes, axis: .vertical)
                        .font(VFont.body)
                        .lineLimit(3...6)
                }
            }
            .navigationTitle("New Contact")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saveContact()
                    }
                    .disabled(!canSave)
                }
            }
        }
    }

    private func saveContact() {
        // TODO: DaemonClient does not currently have a `sendCreateContact` method.
        // When the API is available, call it here with name and notes.
        // For now, dismiss the sheet — the contact creation API gap needs to be
        // addressed in the shared IPC layer.
        dismiss()
    }
}
#endif
