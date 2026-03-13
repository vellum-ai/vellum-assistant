#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct MemoryItemCreateView: View {
    @ObservedObject var store: MemoryItemsStore
    @Environment(\.dismiss) private var dismiss

    @State private var kind: String = "identity"
    @State private var subject: String = ""
    @State private var statement: String = ""
    @State private var importance: Double = 0.8
    @State private var isCreating = false

    private var canCreate: Bool {
        !subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !statement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        Form {
            Section("Kind") {
                Picker("Kind", selection: $kind) {
                    ForEach(MemoryKind.allCases) { memoryKind in
                        Text(memoryKind.label).tag(memoryKind.rawValue)
                    }
                }
                .pickerStyle(.menu)
            }

            Section("Content") {
                TextField("Brief topic or label", text: $subject)
                    .font(VFont.body)

                ZStack(alignment: .topLeading) {
                    if statement.isEmpty {
                        Text("What should the assistant remember?")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentTertiary)
                            .padding(.top, 8)
                            .padding(.leading, 4)
                            .allowsHitTesting(false)
                    }
                    TextEditor(text: $statement)
                        .font(VFont.body)
                        .frame(minHeight: 100)
                }
            }

            Section {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack {
                        Text("Importance")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        Spacer()
                        Text("\(Int(importance * 100))%")
                            .font(VFont.body)
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
                Button("Create") {
                    createMemory()
                }
                .disabled(!canCreate || isCreating)
            }
        }
        .interactiveDismissDisabled(isCreating)
    }

    // MARK: - Actions

    private func createMemory() {
        isCreating = true
        Task {
            _ = await store.createItem(
                kind: kind,
                subject: subject.trimmingCharacters(in: .whitespacesAndNewlines),
                statement: statement.trimmingCharacters(in: .whitespacesAndNewlines),
                importance: importance
            )
            dismiss()
        }
    }
}
#endif
