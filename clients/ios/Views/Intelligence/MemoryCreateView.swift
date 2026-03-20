#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct MemoryCreateView: View {
    @ObservedObject var store: SimplifiedMemoryStore
    @Environment(\.dismiss) private var dismiss

    @State private var content: String = ""
    @State private var isCreating = false
    @State private var errorMessage: String?

    private var canCreate: Bool {
        !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        Form {
            Section("Content") {
                ZStack(alignment: .topLeading) {
                    if content.isEmpty {
                        Text("What should the assistant remember?")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentTertiary)
                            .padding(.top, 8)
                            .padding(.leading, 4)
                            .allowsHitTesting(false)
                    }
                    TextEditor(text: $content)
                        .font(VFont.body)
                        .frame(minHeight: 100)
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage)
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemNegativeStrong)
                }
            }
        }
        .navigationTitle("New Memory")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Create") {
                    createObservation()
                }
                .disabled(!canCreate || isCreating)
            }
        }
        .interactiveDismissDisabled(isCreating)
    }

    // MARK: - Actions

    private func createObservation() {
        isCreating = true
        errorMessage = nil
        Task {
            let result = await store.createObservation(
                content: content.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            isCreating = false
            if result != nil {
                dismiss()
            } else {
                errorMessage = "Failed to create memory. Please try again."
            }
        }
    }
}
#endif
