#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct MemoryItemCreateView: View {
    var store: MemoryItemsStore
    @Environment(\.dismiss) private var dismiss

    @State private var kind: String = "identity"
    @State private var subject: String = ""
    @State private var statement: String = ""
    @State private var importance: Double = 0.8
    @State private var isCreating = false
    @State private var showError = false

    var body: some View {
        Form {
            Section("Kind") {
                Picker("Kind", selection: $kind) {
                    ForEach(MemoryKind.userCreatableKinds) { memoryKind in
                        Text(memoryKind.label).tag(memoryKind.rawValue)
                    }
                }
                .pickerStyle(.menu)
            }

            Section("Subject") {
                TextField("Brief topic or label", text: $subject)
                    .font(VFont.bodyMediumLighter)
            }

            Section("Statement") {
                TextEditor(text: $statement)
                    .font(VFont.bodyMediumLighter)
                    .frame(minHeight: 100)
                    .overlay(alignment: .topLeading) {
                        if statement.isEmpty {
                            Text("What should the assistant remember?")
                                .font(VFont.bodyMediumLighter)
                                .foregroundColor(VColor.contentTertiary)
                                .padding(.top, 8)
                                .padding(.leading, 4)
                                .allowsHitTesting(false)
                        }
                    }
            }

            Section {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack {
                        Text("Importance")
                            .font(VFont.labelDefault)
                            .foregroundColor(VColor.contentTertiary)
                        Spacer()
                        Text("\(Int(importance * 100))%")
                            .font(VFont.bodyMediumLighter)
                            .foregroundColor(VColor.contentDefault)
                    }
                    Slider(value: $importance, in: 0...1, step: 0.1)
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
                Button(isCreating ? "Creating..." : "Create") { create() }
                    .disabled(!isFormValid || isCreating)
            }
        }
        .alert("Error", isPresented: $showError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Failed to create memory. Please try again.")
        }
    }

    private var isFormValid: Bool {
        !subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !statement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func create() {
        isCreating = true
        Task {
            let result = await store.createItem(
                kind: kind,
                subject: subject.trimmingCharacters(in: .whitespacesAndNewlines),
                statement: statement.trimmingCharacters(in: .whitespacesAndNewlines),
                importance: importance
            )
            isCreating = false
            if result != nil {
                dismiss()
            } else {
                showError = true
            }
        }
    }
}
#endif
