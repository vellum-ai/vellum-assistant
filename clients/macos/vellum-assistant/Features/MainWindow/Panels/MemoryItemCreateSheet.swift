import SwiftUI
import VellumAssistantShared

struct MemoryItemCreateSheet: View {
    let store: MemoryItemsStore
    let onDismiss: () -> Void

    @State private var kind: String = "semantic"
    @State private var subject: String = ""
    @State private var statement: String = ""
    @State private var importance: Double = 0.8
    @State private var isCreating = false
    @State private var errorMessage: String?

    var body: some View {
        VModal(title: "New Memory") {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                // Kind picker
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Kind")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    VDropdown(
                        placeholder: "Kind",
                        selection: $kind,
                        options: MemoryKind.userCreatableKinds.map { ($0.label, $0.rawValue) }
                    )
                }

                // Subject
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Subject")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    VTextField(placeholder: "Brief topic or label", text: $subject)
                }

                // Statement
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Statement")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    TextEditor(text: $statement)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentDefault)
                        .scrollContentBackground(.hidden)
                        .padding(VSpacing.sm)
                        .background(VColor.surfaceActive)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .stroke(VColor.borderBase, lineWidth: 1)
                        )
                        .frame(minHeight: 100)
                        .overlay(alignment: .topLeading) {
                            if statement.isEmpty {
                                Text("What should the assistant remember?")
                                    .font(VFont.bodyMediumLighter)
                                    .foregroundStyle(VColor.contentTertiary)
                                    .padding(VSpacing.sm)
                                    .padding(.top, 1)
                                    .allowsHitTesting(false)
                            }
                        }
                }

                // Importance slider
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack {
                        Text("Importance")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        Spacer()
                        Text("\(Int(importance * 100))%")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)
                    }
                    VSlider(value: $importance, range: 0...1, step: 0.1)
                }

                if let errorMessage {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.circleAlert, size: 11)
                            .foregroundStyle(VColor.systemNegativeStrong)
                        Text(errorMessage)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.systemNegativeStrong)
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
                    label: isCreating ? "Creating..." : "Create",
                    leftIcon: isCreating ? nil : VIcon.plus.rawValue,
                    style: .primary,
                    isDisabled: !isFormValid || isCreating
                ) {
                    create()
                }
            }
        }
        .frame(width: 480, height: 460)
    }

    // MARK: - Validation

    private var isFormValid: Bool {
        !subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !statement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Actions

    private func create() {
        isCreating = true
        errorMessage = nil
        Task {
            let result = await store.createItem(
                kind: kind,
                subject: subject.trimmingCharacters(in: .whitespacesAndNewlines),
                statement: statement.trimmingCharacters(in: .whitespacesAndNewlines),
                importance: importance
            )
            isCreating = false
            if result != nil {
                onDismiss()
            } else {
                errorMessage = "Failed to create memory. Please try again."
            }
        }
    }
}
