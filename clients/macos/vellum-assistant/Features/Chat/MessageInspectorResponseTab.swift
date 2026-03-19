import Foundation
import SwiftUI
import VellumAssistantShared

struct MessageInspectorResponseTab: View {
    let entry: LLMRequestLogEntry

    private var model: MessageInspectorResponseTabModel {
        MessageInspectorResponseTabModel(entry: entry)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                if model.hasNormalizedSections {
                    responseMetadataCard

                    ForEach(model.sections) { section in
                        responseSectionCard(for: section)
                    }
                } else {
                    fallbackCard
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(VColor.surfaceBase)
    }

    private var responseMetadataCard: some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Response metadata")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)

                HStack(alignment: .top, spacing: VSpacing.xs) {
                    if let stopReason = model.responseStopReason {
                        metadataChip("Stop reason: \(stopReason)")
                    }

                    if let responseModeLabel = model.responseModeLabel {
                        metadataChip(responseModeLabel)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func responseSectionCard(for section: MessageInspectorResponseSectionModel) -> some View {
        switch section.presentationKind {
        case .assistantText:
            textSectionCard(for: section)
        case .toolCall:
            toolCallSectionCard(for: section)
        case .other:
            otherSectionCard(for: section)
        }
    }

    private func textSectionCard(for section: MessageInspectorResponseSectionModel) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                sectionHeader(
                    title: section.title,
                    kindLabel: section.kindLabel,
                    copyText: section.copyText
                )

                if let body = section.bodyText, !body.isEmpty {
                    Text(body)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentDefault)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                } else {
                    Text("No assistant text was captured for this section.")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }
            }
        }
    }

    private func toolCallSectionCard(for section: MessageInspectorResponseSectionModel) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                sectionHeader(
                    title: section.title,
                    kindLabel: section.kindLabel,
                    copyText: section.copyText
                )

                if let toolName = section.toolName {
                    metadataChip("Tool: \(toolName)")
                }

                if let body = section.bodyText, !body.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text("Arguments preview")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)

                        Text(body)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.contentDefault)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                } else {
                    Text("No structured arguments preview is available for this tool call.")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }

                VInlineMessage(
                    "Need the full provider payload? Open the Raw tab for request and response JSON.",
                    tone: .info
                )
            }
        }
    }

    private func otherSectionCard(for section: MessageInspectorResponseSectionModel) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                sectionHeader(
                    title: section.title,
                    kindLabel: section.kindLabel,
                    copyText: section.copyText
                )

                if let body = section.bodyText, !body.isEmpty {
                    Text(body)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.contentSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                } else {
                    Text("This normalized section does not currently map to a dedicated response card.")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }
            }
        }
    }

    private var fallbackCard: some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                HStack(alignment: .center, spacing: VSpacing.xs) {
                    VIconView(.fileCode, size: 14)
                        .foregroundColor(VColor.contentTertiary)

                    Text("No normalized response sections")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentDefault)
                }

                Text(
                    model.fallbackMessage
                    ?? "This provider response has not been normalized yet. Open the Raw tab to inspect the full provider payload."
                )
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func sectionHeader(
        title: String,
        kindLabel: String,
        copyText: String
    ) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(title)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)

                metadataChip(kindLabel)
            }

            Spacer(minLength: VSpacing.md)

            VCopyButton(
                text: copyText,
                size: .compact,
                accessibilityHint: "Copy section content"
            )
        }
    }

    private func metadataChip(_ label: String) -> some View {
        Text(label)
            .font(VFont.caption)
            .foregroundColor(VColor.contentSecondary)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .background(VColor.surfaceOverlay)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }
}

struct MessageInspectorResponseTabModel: Equatable {
    let sections: [MessageInspectorResponseSectionModel]
    let responseModeLabel: String?
    let responseStopReason: String?
    let fallbackMessage: String?

    init(entry: LLMRequestLogEntry) {
        let responseSections = entry.responseSections ?? []
        sections = responseSections.enumerated().map { index, section in
            MessageInspectorResponseSectionModel(index: index, section: section)
        }

        if sections.isEmpty {
            responseModeLabel = nil
            responseStopReason = nil
        } else {
            responseModeLabel = Self.deriveResponseModeLabel(summary: entry.summary, sections: sections)
            responseStopReason = Self.deriveStopReasonLabel(summary: entry.summary)
        }

        fallbackMessage = sections.isEmpty
            ? "This provider response has not been normalized yet. Open the Raw tab to inspect the full provider payload."
            : nil
    }

    var hasNormalizedSections: Bool {
        !sections.isEmpty
    }

    private static func deriveResponseModeLabel(
        summary: LLMCallSummary?,
        sections: [MessageInspectorResponseSectionModel]
    ) -> String? {
        if let responseToolCallCount = summary?.responseToolCallCount, responseToolCallCount > 0 {
            return "Tool-calling response"
        }

        if sections.contains(where: { $0.isToolCallSection }) {
            return "Tool-calling response"
        }

        let hasAssistantText = sections.contains(where: { $0.presentationKind == .assistantText })
        let hasResultSection = sections.contains(where: { $0.isResultSection })

        if hasAssistantText && !hasResultSection {
            return "Text-only response"
        }

        if hasResultSection && !hasAssistantText {
            return "Result-only response"
        }

        return nil
    }

    private static func deriveStopReasonLabel(summary: LLMCallSummary?) -> String? {
        guard let stopReason = summary?.stopReason?.trimmingCharacters(in: .whitespacesAndNewlines),
              !stopReason.isEmpty else {
            return nil
        }

        return stopReason
    }
}

struct MessageInspectorResponseSectionModel: Identifiable, Equatable {
    enum PresentationKind: Equatable {
        case assistantText
        case toolCall
        case other
    }

    let id: Int
    let title: String
    let kindLabel: String
    let bodyText: String?
    let toolName: String?
    let copyText: String
    let presentationKind: PresentationKind
    let isToolCallSection: Bool
    let isResultSection: Bool

    var showsRawPayloadHint: Bool {
        presentationKind == .toolCall
    }

    init(index: Int, section: LLMContextSection) {
        id = index
        toolName = section.toolName

        let displayTitle = section.label.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallbackTitle = "Section \(index + 1)"
        title = displayTitle.isEmpty ? fallbackTitle : displayTitle

        switch section.kind {
        case .tool, .toolUse, .functionCall:
            presentationKind = .toolCall
            isToolCallSection = true
            isResultSection = false
            kindLabel = "Tool call"
            let preview = Self.previewText(for: section.data) ?? section.text
            bodyText = preview
            let copySource = preview ?? title
            copyText = copySource
        case .toolResult, .functionResponse:
            presentationKind = .other
            isToolCallSection = false
            isResultSection = true
            kindLabel = section.kind == .functionResponse ? "Function response" : "Tool result"
            let preview = Self.previewText(for: section.data) ?? section.text
            bodyText = preview
            copyText = preview ?? title
        case .assistant, .message, .text, .output, .completion, .reasoning, .markdown, .code, .json:
            presentationKind = .assistantText
            isToolCallSection = false
            isResultSection = false
            kindLabel = "Assistant text"
            bodyText = section.text ?? Self.previewText(for: section.data)
            copyText = bodyText ?? title
        default:
            let preview = section.text ?? Self.previewText(for: section.data)
            presentationKind = preview == nil ? .other : .assistantText
            isToolCallSection = false
            isResultSection = false
            kindLabel = section.kind.rawValue
            bodyText = preview
            copyText = bodyText ?? title
        }
    }

    private static func previewText(for data: AnyCodable?) -> String? {
        guard let value = data?.value else { return nil }

        if let string = value as? String {
            return string
        }

        if let jsonValue = jsonCompatibleValue(value),
           JSONSerialization.isValidJSONObject(jsonValue),
           let data = try? JSONSerialization.data(withJSONObject: jsonValue, options: [.prettyPrinted, .sortedKeys]),
           let string = String(data: data, encoding: .utf8) {
            return string
        }

        return String(describing: value)
    }

    private static func jsonCompatibleValue(_ value: Any?) -> Any? {
        guard let value else { return nil }

        if value is NSNull || value is String || value is Bool || value is Int || value is Double {
            return value
        }

        if let dictionary = value as? [String: Any] {
            return dictionary.mapValues { jsonCompatibleValue($0) ?? NSNull() }
        }

        if let array = value as? [Any] {
            return array.map { jsonCompatibleValue($0) ?? NSNull() }
        }

        return nil
    }
}
