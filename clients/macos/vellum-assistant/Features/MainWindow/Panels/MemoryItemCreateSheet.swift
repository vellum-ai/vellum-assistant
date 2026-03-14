import SwiftUI
import VellumAssistantShared

struct MemoryItemCreateSheet: View {
    let store: MemoryItemsStore
    let onDismiss: () -> Void

    @State private var kind: String = "identity"
    @State private var subject: String = ""
    @State private var statement: String = ""
    @State private var importance: Double = 0.8
    @State private var isCreating = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(VColor.borderBase)

            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    // Kind picker
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Kind")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        VDropdown(
                            placeholder: "Kind",
                            selection: $kind,
                            options: MemoryKind.allCases.map { ($0.label, $0.rawValue) }
                        )
                    }

                    // Subject
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Subject")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        VTextField(placeholder: "Brief topic or label", text: $subject)
                    }

                    // Statement
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Statement")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        TextEditor(text: $statement)
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
                            .frame(minHeight: 100)
                            .overlay(alignment: .topLeading) {
                                if statement.isEmpty {
                                    Text("What should the assistant remember?")
                                        .font(VFont.body)
                                        .foregroundColor(VColor.contentTertiary)
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
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                            Spacer()
                            Text("\(Int(importance * 100))%")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentSecondary)
                        }
                        VSlider(value: $importance, range: 0...1, step: 0.1)
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
                .padding(VSpacing.xl)
            }

            Divider().background(VColor.borderBase)
            footer
        }
        .frame(width: 480, height: 460)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.plus, size: 14)
                .foregroundColor(VColor.primaryBase)
            Text("New Memory")
                .font(VFont.display)
                .foregroundColor(VColor.contentDefault)
            Spacer()
            Button {
                onDismiss()
            } label: {
                VIconView(.x, size: 11)
                    .foregroundColor(VColor.contentTertiary)
                    .frame(width: 24, height: 24)
                    .background(VColor.surfaceBase)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
        }
        .padding(.horizontal, VSpacing.xl)
        .padding(.vertical, VSpacing.lg)
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            Button {
                onDismiss()
            } label: {
                Text("Cancel")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentSecondary)
            }
            .buttonStyle(.plain)

            Spacer()

            VButton(
                label: isCreating ? "Creating..." : "Create",
                leftIcon: isCreating ? nil : VIcon.plus.rawValue,
                style: .primary,
                isDisabled: !isFormValid || isCreating
            ) {
                create()
            }
        }
        .padding(.horizontal, VSpacing.xl)
        .padding(.vertical, VSpacing.lg)
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
