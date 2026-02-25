import SwiftUI
import VellumAssistantShared

struct NewSkillSheet: View {
    @ObservedObject var skillsManager: SkillsManager
    @Environment(\.dismiss) var dismiss

    // Input state
    @State private var sourceText = ""

    // Editable draft fields (populated after draft generation)
    @State private var skillId = ""
    @State private var name = ""
    @State private var description = ""
    @State private var emoji = ""
    @State private var bodyMarkdown = ""
    @State private var hasDraft = false
    @State private var warnings: [String] = []

    var body: some View {
        VStack(spacing: 0) {
            header

            Divider().background(VColor.surfaceBorder)

            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    if !hasDraft {
                        inputSection
                    } else {
                        editSection
                    }
                }
                .padding(VSpacing.xl)
            }

            Divider().background(VColor.surfaceBorder)

            footer
        }
        .frame(width: 560, height: 520)
        .background(VColor.background)
        .onChange(of: skillsManager.draftResult?.skillId) {
            if let result = skillsManager.draftResult {
                skillId = result.skillId
                name = result.name
                description = result.description
                emoji = result.emoji ?? ""
                bodyMarkdown = result.bodyMarkdown
                warnings = result.warnings
                hasDraft = true
            }
        }
        .onChange(of: skillsManager.isCreating) {
            if !skillsManager.isCreating && skillsManager.createError == nil && hasDraft {
                dismiss()
            }
        }
        .onDisappear {
            skillsManager.resetDraftState()
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Text("New Skill")
                .font(VFont.headline)
                .foregroundColor(VColor.textPrimary)
            Spacer()
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .foregroundColor(VColor.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
        }
        .padding(VSpacing.xl)
    }

    // MARK: - Input Section (paste text)

    private var inputSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Paste your skill text or SKILL.md content below:")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)

            TextEditor(text: $sourceText)
                .font(VFont.mono)
                .foregroundColor(VColor.textPrimary)
                .scrollContentBackground(.hidden)
                .background(VColor.surfaceSubtle)
                .cornerRadius(VRadius.md)
                .frame(minHeight: 240)

            if let error = skillsManager.draftError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }
        }
    }

    // MARK: - Edit Section (after draft)

    private var editSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if !warnings.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(warnings, id: \.self) { warning in
                        HStack(spacing: VSpacing.xs) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundColor(VColor.warning)
                                .font(.caption)
                            Text(warning)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textSecondary)
                        }
                    }
                }
            }

            formField(label: "Skill ID", text: $skillId, placeholder: "my-skill-id")
            formField(label: "Name", text: $name, placeholder: "My Skill")
            formField(label: "Description", text: $description, placeholder: "A short description")
            formField(label: "Emoji", text: $emoji, placeholder: "")

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Body")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                TextEditor(text: $bodyMarkdown)
                    .font(VFont.mono)
                    .foregroundColor(VColor.textPrimary)
                    .scrollContentBackground(.hidden)
                    .background(VColor.surfaceSubtle)
                    .cornerRadius(VRadius.md)
                    .frame(minHeight: 200)
            }

            if let error = skillsManager.createError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            if hasDraft {
                Button {
                    hasDraft = false
                    skillsManager.resetDraftState()
                } label: {
                    Text("Back")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
                .buttonStyle(.plain)
            }

            Spacer()

            if !hasDraft {
                VButton(
                    label: skillsManager.isDrafting ? "Generating..." : "Generate Draft",
                    style: .primary,
                    isDisabled: sourceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || skillsManager.isDrafting
                ) {
                    skillsManager.draftSkill(sourceText: sourceText)
                }
            } else {
                VButton(
                    label: skillsManager.isCreating ? "Creating..." : "Create Skill",
                    style: .primary,
                    isDisabled: !isFormValid || skillsManager.isCreating
                ) {
                    skillsManager.createSkillFromDraft(
                        skillId: skillId.trimmingCharacters(in: .whitespacesAndNewlines),
                        name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                        description: description.trimmingCharacters(in: .whitespacesAndNewlines),
                        emoji: emoji.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : emoji.trimmingCharacters(in: .whitespacesAndNewlines),
                        bodyMarkdown: bodyMarkdown
                    )
                }
            }
        }
        .padding(VSpacing.xl)
    }

    // MARK: - Helpers

    private var isFormValid: Bool {
        !skillId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !bodyMarkdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func formField(label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
            TextField(placeholder, text: text)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.sm)
                .background(VColor.surfaceSubtle)
                .cornerRadius(VRadius.sm)
        }
    }
}
