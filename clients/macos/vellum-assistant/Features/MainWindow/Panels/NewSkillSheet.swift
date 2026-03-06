import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

struct NewSkillSheet: View {
    @ObservedObject var skillsManager: SkillsManager
    @Environment(\.dismiss) var dismiss

    // Input state
    @State private var sourceText = ""
    @State private var droppedFileName: String?
    @State private var isDropTargeted = false
    @State private var dropError: String?

    // Editable draft fields (populated after draft generation)
    @State private var skillId = ""
    @State private var name = ""
    @State private var description = ""
    @State private var emoji = ""
    @State private var bodyMarkdown = ""
    @State private var hasDraft = false
    @State private var warnings: [String] = []

    private static let allowedExtensions: Set<String> = ["md", "txt", "markdown"]

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
        .frame(width: 560, height: 560)
        .background(VColor.background)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
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
        HStack(spacing: VSpacing.sm) {
            VIconView(.sparkles, size: 14)
                .foregroundColor(Forest._400)
            Text("New Skill")
                .font(VFont.display)
                .foregroundColor(VColor.textPrimary)
            Spacer()
            Button {
                dismiss()
            } label: {
                VIconView(.x, size: 11)
                    .foregroundColor(VColor.textMuted)
                    .frame(width: 24, height: 24)
                    .background(VColor.ghostHover)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
        }
        .padding(.horizontal, VSpacing.xl)
        .padding(.vertical, VSpacing.lg)
    }

    // MARK: - Input Section (paste text or drop file)

    private var inputSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Drop zone
            dropZone

            // Divider with "or"
            HStack(spacing: VSpacing.md) {
                Rectangle()
                    .fill(VColor.surfaceBorder)
                    .frame(height: 1)
                Text("or paste content")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                Rectangle()
                    .fill(VColor.surfaceBorder)
                    .frame(height: 1)
            }

            // Text editor
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                TextEditor(text: $sourceText)
                    .font(VFont.mono)
                    .foregroundColor(VColor.textPrimary)
                    .scrollContentBackground(.hidden)
                    .padding(VSpacing.sm)
                    .background(VColor.surfaceSubtle)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
                    .frame(minHeight: 140)
            }

            if let error = dropError {
                errorLabel(error)
            }

            if let error = skillsManager.draftError {
                errorLabel(error)
            }
        }
    }

    private var dropZone: some View {
        ZStack {
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(isDropTargeted ? Forest._900.opacity(0.3) : VColor.surfaceSubtle)
            RoundedRectangle(cornerRadius: VRadius.lg)
                .strokeBorder(
                    isDropTargeted ? Forest._500 : VColor.surfaceBorder,
                    style: StrokeStyle(lineWidth: isDropTargeted ? 2 : 1, dash: [6, 4])
                )

            VStack(spacing: VSpacing.md) {
                VIconView(isDropTargeted ? .arrowDownToLine : .fileText, size: 28)
                    .foregroundColor(isDropTargeted ? Forest._400 : VColor.textMuted)

                VStack(spacing: VSpacing.xs) {
                    Text("Drop a .md or .txt file here")
                        .font(VFont.bodyMedium)
                        .foregroundColor(isDropTargeted ? Forest._300 : VColor.textSecondary)

                    if let fileName = droppedFileName {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.circleCheck, size: 11)
                                .foregroundColor(VColor.success)
                            Text(fileName)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                    }
                }
            }
            .padding(VSpacing.xl)
        }
        .frame(height: 120)
        .animation(VAnimation.fast, value: isDropTargeted)
        .onDrop(of: [.fileURL], isTargeted: $isDropTargeted) { providers in
            handleDrop(providers)
        }
    }

    // MARK: - Edit Section (after draft)

    private var editSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if !warnings.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(warnings, id: \.self) { warning in
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.triangleAlert, size: 11)
                                .foregroundColor(VColor.warning)
                            Text(warning)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textSecondary)
                        }
                    }
                }
            }

            formField(label: "Skill ID", text: $skillId, placeholder: "my-skill-id", error: skillIdError)
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
                    .padding(VSpacing.sm)
                    .background(VColor.surfaceSubtle)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
                    .frame(minHeight: 200)
            }

            if let error = skillsManager.createError {
                errorLabel(error)
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
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.chevronLeft, size: 10)
                        Text("Back")
                            .font(VFont.bodyMedium)
                    }
                    .foregroundColor(VColor.textSecondary)
                }
                .buttonStyle(.plain)
            }

            Spacer()

            if !hasDraft {
                VButton(
                    label: skillsManager.isDrafting ? "Generating..." : "Generate Draft",
                    leftIcon: skillsManager.isDrafting ? nil : "wand.and.stars",
                    style: .primary,
                    size: .medium,
                    isDisabled: sourceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || skillsManager.isDrafting
                ) {
                    skillsManager.draftSkill(sourceText: sourceText)
                }
            } else {
                VButton(
                    label: skillsManager.isCreating ? "Creating..." : "Create Skill",
                    leftIcon: skillsManager.isCreating ? nil : "plus.circle.fill",
                    style: .primary,
                    size: .medium,
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
        .padding(.horizontal, VSpacing.xl)
        .padding(.vertical, VSpacing.lg)
    }

    // MARK: - Drag & Drop

    private func handleDrop(_ providers: [NSItemProvider]) -> Bool {
        dropError = nil
        guard let provider = providers.first else { return false }

        provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
            guard let url = Self.fileURL(from: item) else {
                DispatchQueue.main.async { dropError = "Could not read the dropped file." }
                return
            }

            let ext = url.pathExtension.lowercased()
            guard Self.allowedExtensions.contains(ext) else {
                DispatchQueue.main.async {
                    dropError = "Unsupported file type \".\(ext)\". Please drop a .md or .txt file."
                }
                return
            }

            do {
                let contents = try String(contentsOf: url, encoding: .utf8)
                let trimmed = contents.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else {
                    DispatchQueue.main.async { dropError = "The dropped file is empty." }
                    return
                }

                DispatchQueue.main.async {
                    guard !skillsManager.isDrafting else {
                        dropError = "A draft is already being generated. Please wait or go back and try again."
                        return
                    }
                    sourceText = trimmed
                    droppedFileName = url.lastPathComponent
                    // Auto-trigger draft generation
                    skillsManager.draftSkill(sourceText: trimmed)
                }
            } catch {
                DispatchQueue.main.async { dropError = "Failed to read file: \(error.localizedDescription)" }
            }
        }

        return true
    }

    /// Parse a file URL from a drop item, handling Data, URL, and String representations.
    /// NSItemProvider.loadItem may return any of these depending on drag source.
    private static func fileURL(from item: NSSecureCoding?) -> URL? {
        if let data = item as? Data {
            return URL(dataRepresentation: data, relativeTo: nil)
        }
        if let url = item as? URL {
            return url
        }
        if let str = item as? String, let url = URL(string: str), url.isFileURL {
            return url
        }
        return nil
    }

    // MARK: - Helpers

    private var skillIdError: String? {
        let trimmed = skillId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if skillsManager.skills.contains(where: { $0.id == trimmed }) {
            return "A skill with this ID already exists"
        }
        return nil
    }

    private var isFormValid: Bool {
        !skillId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !bodyMarkdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        skillIdError == nil
    }

    private func errorLabel(_ text: String) -> some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(.circleAlert, size: 11)
                .foregroundColor(VColor.error)
            Text(text)
                .font(VFont.caption)
                .foregroundColor(VColor.error)
        }
    }

    private func formField(label: String, text: Binding<String>, placeholder: String, error: String? = nil) -> some View {
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
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(error != nil ? VColor.error : VColor.surfaceBorder, lineWidth: 1)
                )
            if let error {
                errorLabel(error)
            }
        }
    }
}
