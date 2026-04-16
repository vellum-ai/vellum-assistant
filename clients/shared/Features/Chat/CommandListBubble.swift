import Foundation
import SwiftUI

public struct CommandListBubble: View {
    public struct CommandEntry: Identifiable, Equatable {
        public let id: String
        public let description: String

        public init(id: String, description: String) {
            self.id = id
            self.description = description
        }
    }

    private let commands: [CommandEntry]

    public init(commands: [CommandEntry]) {
        self.commands = commands
    }

    public static func parsedEntries(from assistantText: String) -> [CommandEntry]? {
        var commands: [CommandEntry] = []

        for rawLine in assistantText.split(
            omittingEmptySubsequences: false,
            whereSeparator: \.isNewline
        ) {
            let trimmed = String(rawLine).trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            if trimmed.caseInsensitiveCompare("COMMANDS") == .orderedSame {
                continue
            }
            guard let entry = parseEntry(from: Substring(trimmed)) else {
                return nil
            }
            commands.append(entry)
        }

        return commands.isEmpty ? nil : commands
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            Text("COMMANDS")
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentTertiary)
                .tracking(0.5)
                .padding(.horizontal, VSpacing.lg)
                .padding(.top, VSpacing.sm)
                .padding(.bottom, VSpacing.xs)

            // Command rows
            ForEach(commands) { command in
                HStack(spacing: VSpacing.sm) {
                    Text(command.id)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.primaryBase)
                        .frame(width: 100, alignment: .leading)

                    Text(command.description)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)

                    Spacer()
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.xs + 2)
            }
        }
        .padding(.vertical, VSpacing.xs)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .widthCap(400)
    }

    private static func parseEntry(from rawLine: Substring) -> CommandEntry? {
        let trimmed = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let stripped = trimmed.trimmingLeadingListMarker()
        let unwrapped = stripped.trimmingCharacters(in: CharacterSet(charactersIn: "`"))
        guard unwrapped.hasPrefix("/") else { return nil }

        let commandEnd = unwrapped.firstIndex(where: {
            $0.isWhitespace || $0 == "-" || $0 == "–" || $0 == "—" || $0 == ":" || $0 == "`"
        }) ?? unwrapped.endIndex
        let commandToken = String(unwrapped[..<commandEnd]).trimmingCharacters(in: CharacterSet(charactersIn: "`"))
        guard commandToken.count > 1 else { return nil }

        let description = String(unwrapped[commandEnd...])
            .trimmingCharacters(in: CharacterSet(charactersIn: "`").union(.whitespacesAndNewlines))
            .trimmingLeadingListMarker()
        guard !description.isEmpty else { return nil }

        return CommandEntry(id: commandToken, description: description)
    }
}

private extension String {
    func trimmingLeadingListMarker() -> String {
        var index = startIndex
        while index < endIndex {
            let character = self[index]
            if character.isWhitespace || character == "-" || character == "*" || character == "•" || character == "·" || character == "–" || character == "—" {
                index = self.index(after: index)
                continue
            }
            break
        }
        return String(self[index...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
