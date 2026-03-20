import SwiftUI
import VellumAssistantShared

struct MemoryCreateSheet: View {
    let store: SimplifiedMemoryStore
    let onDismiss: () -> Void

    @State private var content: String = ""
    @State private var isCreating = false
    @State private var errorMessage: String?

    var body: some View {
        VModal(title: "Add Memory") {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Content")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                    TextEditor(text: $content)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentDefault)
                        .scrollContentBackground(.hidden)
                        .padding(VSpacing.sm)
                        .background(VColor.surfaceActive)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .stroke(VColor.borderBase, lineWidth: 1)
                        )
                        .frame(minHeight: 120)
                        .overlay(alignment: .topLeading) {
                            if content.isEmpty {
                                Text("What should your assistant remember?")
                                    .font(VFont.body)
                                    .foregroundColor(VColor.contentTertiary)
                                    .padding(VSpacing.sm)
                                    .padding(.top, 1)
                                    .allowsHitTesting(false)
                            }
                        }
                }

                if let errorMessage {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.circleAlert, size: 11)
                            .foregroundColor(VColor.systemNegativeStrong)
                        Text(errorMessage)
                            .font(VFont.caption)
                            .foregroundColor(VColor.systemNegativeStrong)
                    }
                }
            }
        } footer: {
            HStack {
                Spacer()
                VButton(label: "Cancel", style: .outlined) {
                    onDismiss()
                }
                VButton(
                    label: isCreating ? "Adding..." : "Add",
                    leftIcon: isCreating ? nil : VIcon.plus.rawValue,
                    style: .primary,
                    isDisabled: !isFormValid || isCreating
                ) {
                    create()
                }
            }
        }
        .frame(width: 480, height: 340)
    }

    // MARK: - Validation

    private var isFormValid: Bool {
        !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Actions

    private func create() {
        isCreating = true
        errorMessage = nil
        Task {
            let result = await store.createObservation(
                content: content.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            isCreating = false
            if result != nil {
                onDismiss()
            } else {
                errorMessage = "Failed to add memory. Please try again."
            }
        }
    }
}
