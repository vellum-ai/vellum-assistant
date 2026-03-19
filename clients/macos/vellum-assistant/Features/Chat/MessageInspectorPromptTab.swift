import Foundation
import SwiftUI
import VellumAssistantShared

struct MessageInspectorPromptTab: View {
    let entry: LLMRequestLogEntry

    private var model: MessageInspectorPromptTabModel {
        MessageInspectorPromptTabModel(entry: entry)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                headerCard

                if model.sections.isEmpty {
                    emptyState
                } else {
                    LazyVStack(alignment: .leading, spacing: VSpacing.md) {
                        ForEach(model.sections) { section in
                            sectionCard(section)
                        }
                    }
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(VColor.surfaceBase)
    }

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Prompt sections")
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.contentDefault)

            Text(model.bannerText)
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
    }

    private var emptyState: some View {
        VEmptyState(
            title: "No normalized prompt sections",
            subtitle: model.fallbackMessage,
            icon: VIcon.scrollText.rawValue
        )
        .frame(minHeight: 280)
    }

    private func sectionCard(_ section: MessageInspectorPromptSectionModel) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: VSpacing.sm) {
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text(section.title)
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentDefault)
                        .lineLimit(2)

                    HStack(spacing: VSpacing.xs) {
                        Text(section.kindLabel)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)

                        if let formatLabel = section.formatLabel {
                            Text(formatLabel)
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentSecondary)
                        }
                    }
                }

                Spacer(minLength: VSpacing.md)

                VCopyButton(
                    text: section.copyText,
                    size: .compact,
                    accessibilityHint: "Copy \(section.title)"
                )
            }

            sectionContent(section)
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
    }

    @ViewBuilder
    private func sectionContent(_ section: MessageInspectorPromptSectionModel) -> some View {
        switch section.presentationStyle {
        case .text:
            Text(section.displayText)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.md)
                .background(VColor.surfaceBase)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        case .structured:
            HighlightedTextView(
                text: .constant(section.displayText),
                language: section.syntaxLanguage,
                isEditable: false,
                isActivelyEditing: .constant(false)
            )
            .frame(maxWidth: .infinity)
            .frame(minHeight: 120, maxHeight: 260)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
    }
}

struct MessageInspectorPromptTabModel {
    let sections: [MessageInspectorPromptSectionModel]
    let bannerText: String
    let fallbackMessage: String

    init(entry: LLMRequestLogEntry) {
        let requestSections = entry.requestSections ?? []
        sections = requestSections.enumerated().map { index, section in
            MessageInspectorPromptSectionModel(index: index, section: section)
        }

        fallbackMessage = "This call has no normalized prompt sections. Use the Raw tab to inspect the full request payload."

        if sections.isEmpty {
            bannerText = "This call has no normalized prompt sections yet."
        } else {
            bannerText = "\(sections.count) normalized request section(s) are shown in the same order returned by the assistant route."
        }
    }
}

struct MessageInspectorPromptSectionModel: Identifiable, Equatable {
    enum PresentationStyle: Equatable {
        case text
        case structured
    }

    let id: String
    let title: String
    let kindLabel: String
    let displayText: String
    let copyText: String
    let syntaxLanguage: SyntaxLanguage
    let presentationStyle: PresentationStyle
    let formatLabel: String?

    init(index: Int, section: LLMContextSection) {
        id = "\(index)"
        title = Self.displayTitle(for: section, index: index)
        kindLabel = Self.displayKindLabel(for: section.kind)

        let renderedContent = Self.renderedContent(for: section)
        displayText = renderedContent.text
        copyText = renderedContent.text
        syntaxLanguage = renderedContent.syntaxLanguage
        presentationStyle = renderedContent.isStructured ? .structured : .text
        formatLabel = renderedContent.formatLabel
    }

    private static func displayTitle(for section: LLMContextSection, index: Int) -> String {
        if let title = section.title, !title.isEmpty {
            return title
        }

        return "\(displayKindLabel(for: section.kind)) \(index + 1)"
    }

    private static func displayKindLabel(for kind: LLMContextSectionKind) -> String {
        kind.rawValue
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.capitalized }
            .joined(separator: " ")
    }

    private static func renderedContent(for section: LLMContextSection) -> (text: String, syntaxLanguage: SyntaxLanguage, isStructured: Bool, formatLabel: String?) {
        let preferredLanguage = syntaxLanguage(for: section.language)

        guard let value = section.content?.value else {
            return ("No content available.", preferredLanguage ?? .plain, false, nil)
        }

        if let string = value as? String {
            return (
                string,
                preferredLanguage ?? .plain,
                false,
                preferredLanguage.flatMap { formatLabel(for: $0) }
            )
        }

        if let json = prettyPrintedJSONString(for: value) {
            let syntaxLanguage = preferredLanguage ?? .json
            return (
                json,
                syntaxLanguage,
                true,
                formatLabel(for: syntaxLanguage)
            )
        }

        let syntaxLanguage = preferredLanguage ?? .plain
        return (
            String(describing: value),
            syntaxLanguage,
            true,
            preferredLanguage.flatMap { formatLabel(for: $0) }
        )
    }

    private static func prettyPrintedJSONString(for value: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(value) else {
            return nil
        }

        guard let data = try? JSONSerialization.data(
            withJSONObject: value,
            options: [.prettyPrinted, .withoutEscapingSlashes]
        ) else {
            return nil
        }

        return String(data: data, encoding: .utf8)
    }

    private static func syntaxLanguage(for language: String?) -> SyntaxLanguage? {
        guard let language else { return nil }

        switch language.lowercased() {
        case "json", "application/json":
            return .json
        case "markdown", "md", "text/markdown":
            return .markdown
        case "javascript", "application/javascript", "text/javascript":
            return .javascript
        case "typescript", "application/typescript", "text/typescript":
            return .typescript
        default:
            return .plain
        }
    }

    private static func formatLabel(for syntaxLanguage: SyntaxLanguage) -> String? {
        switch syntaxLanguage {
        case .json:
            return "JSON"
        case .markdown:
            return "Markdown"
        case .javascript:
            return "JavaScript"
        case .typescript:
            return "TypeScript"
        case .plain:
            return nil
        }
    }
}
