import SwiftUI
import VellumAssistantShared

struct SkillCreateSheet: View {
    let skillsManager: SkillsManager
    let onDismiss: () -> Void

    @State private var name: String = ""
    @State private var skillId: String = ""
    @State private var description: String = ""
    @State private var emoji: String = ""
    @State private var bodyMarkdown: String = ""
    @State private var sourceText: String = ""
    @State private var showAdvanced: Bool = false
    @State private var hasDrafted: Bool = false
    @State private var userEditedSkillId: Bool = false
    @State private var lastAppliedDraftName: String?

    var body: some View {
        VModal(title: "New Skill") {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                if showAdvanced || hasDrafted {
                    formView
                } else {
                    draftView
                }

                // Draft error
                if let draftError = skillsManager.draftError {
                    errorRow(draftError)
                }

                // Create error
                if let createError = skillsManager.createError {
                    errorRow(createError)
                }

                // Draft warnings
                if let warnings = skillsManager.draftResult?.warnings, !warnings.isEmpty {
                    ForEach(warnings, id: \.self) { warning in
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.triangleAlert, size: 11)
                                .foregroundStyle(VColor.systemMidStrong)
                            Text(warning)
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.systemMidStrong)
                        }
                    }
                }
            }
        } footer: {
            HStack {
                Spacer()
                VButton(label: "Cancel", style: .outlined) {
                    dismiss()
                }
                VButton(
                    label: skillsManager.isCreating ? "Creating..." : "Create",
                    leftIcon: skillsManager.isCreating ? nil : VIcon.plus.rawValue,
                    style: .primary,
                    isDisabled: !isFormValid || skillsManager.isCreating
                ) {
                    create()
                }
            }
        }
        .frame(width: 520, height: 560)
        .onChange(of: name) { _, newValue in
            if !userEditedSkillId {
                skillId = deriveSkillId(from: newValue)
            }
        }
        .onChange(of: skillsManager.isDrafting) { wasDrafting, isDrafting in
            if wasDrafting && !isDrafting, let result = skillsManager.draftResult, result.name != lastAppliedDraftName {
                name = result.name
                skillId = result.skillId
                description = result.description
                emoji = result.emoji ?? ""
                bodyMarkdown = result.bodyMarkdown
                userEditedSkillId = true // Don't overwrite drafted skillId
                lastAppliedDraftName = result.name
                hasDrafted = true
            }
        }
        .onChange(of: skillsManager.isCreating) { wasCreating, isCreating in
            if wasCreating && !isCreating && skillsManager.createError == nil {
                dismiss()
            }
        }
    }

    // MARK: - Draft Mode View

    @ViewBuilder
    private var draftView: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Source Text")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
            TextEditor(text: $sourceText)
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
                .frame(minHeight: 200)
                .overlay(alignment: .topLeading) {
                    if sourceText.isEmpty {
                        Text("Paste a skill prompt, instructions, or description...")
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentTertiary)
                            .padding(VSpacing.sm)
                            .padding(.top, 1)
                            .allowsHitTesting(false)
                    }
                }
        }

        HStack {
            VButton(
                label: skillsManager.isDrafting ? "Generating..." : "Generate",
                leftIcon: skillsManager.isDrafting ? nil : VIcon.sparkles.rawValue,
                style: .primary,
                isDisabled: sourceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || skillsManager.isDrafting
            ) {
                skillsManager.draftSkill(sourceText: sourceText.trimmingCharacters(in: .whitespacesAndNewlines))
            }

            if skillsManager.isDrafting {
                VLoadingIndicator(size: 14)
            }

            Spacer()

            Button {
                showAdvanced = true
            } label: {
                Text("Write manually")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
            .buttonStyle(.plain)
            .pointerCursor()
        }
    }

    // MARK: - Manual Form View

    @ViewBuilder
    private var formView: some View {
        // Name
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Name")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
            VTextField(placeholder: "Skill name", text: $name)
        }

        // Skill ID
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Skill ID")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
            VTextField(placeholder: "my-skill-id", text: Binding(
                get: { skillId },
                set: { newValue in
                    skillId = newValue
                    userEditedSkillId = true
                }
            ))
        }

        // Description
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Description")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
            VTextField(placeholder: "What does this skill do?", text: $description)
        }

        // Emoji
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Emoji (optional)")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
            VTextField(placeholder: "🛠️", text: Binding(
                get: { emoji },
                set: { newValue in
                    // Limit to 1 grapheme cluster
                    if newValue.isEmpty {
                        emoji = ""
                    } else {
                        emoji = String(newValue.prefix(1))
                    }
                }
            ))
        }

        // Body / Instructions
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Instructions")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
            TextEditor(text: $bodyMarkdown)
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
                    if bodyMarkdown.isEmpty {
                        Text("Skill instructions in Markdown...")
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentTertiary)
                            .padding(VSpacing.sm)
                            .padding(.top, 1)
                            .allowsHitTesting(false)
                    }
                }
        }
    }

    // MARK: - Error Row

    @ViewBuilder
    private func errorRow(_ message: String) -> some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(.circleAlert, size: 11)
                .foregroundStyle(VColor.systemNegativeStrong)
            Text(message)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.systemNegativeStrong)
        }
    }

    // MARK: - Validation

    private var isFormValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !skillId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !bodyMarkdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Actions

    private func create() {
        skillsManager.createSkillFromDraft(
            skillId: skillId.trimmingCharacters(in: .whitespacesAndNewlines),
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description.trimmingCharacters(in: .whitespacesAndNewlines),
            emoji: emoji.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : emoji.trimmingCharacters(in: .whitespacesAndNewlines),
            bodyMarkdown: bodyMarkdown.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    private func dismiss() {
        skillsManager.resetDraftState()
        onDismiss()
    }

    // MARK: - Helpers

    private func deriveSkillId(from name: String) -> String {
        let lowercased = name.lowercased()
        // Replace non-alphanumeric characters with hyphens
        let replaced = lowercased.map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
        // Collapse consecutive hyphens
        let collapsed = replaced.replacingOccurrences(of: "-{2,}", with: "-", options: .regularExpression)
        // Trim leading/trailing hyphens
        return collapsed.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}
