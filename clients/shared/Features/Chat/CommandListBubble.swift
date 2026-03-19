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
        let commands = assistantText
            .split(whereSeparator: \.isNewline)
            .compactMap(parseEntry(from:))
        return commands.isEmpty ? nil : commands
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            Text("COMMANDS")
                .font(VFont.small)
                .foregroundColor(VColor.contentTertiary)
                .tracking(0.5)
                .padding(.horizontal, VSpacing.lg)
                .padding(.top, VSpacing.sm)
                .padding(.bottom, VSpacing.xs)

            // Command rows
            ForEach(commands) { command in
                HStack(spacing: VSpacing.sm) {
                    Text(command.id)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.primaryBase)
                        .frame(width: 100, alignment: .leading)

                    Text(command.description)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)

                    Spacer()
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.xs + 2)
            }
        }
        .padding(.vertical, VSpacing.xs)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .frame(maxWidth: 400)
    }

    private static func parseEntry(from rawLine: Substring) -> CommandEntry? {
        let trimmed = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let stripped = trimmed.trimmingLeadingListMarker()
        guard stripped.hasPrefix("/") else { return nil }

        let commandEnd = stripped.firstIndex(where: { $0.isWhitespace || $0 == "-" || $0 == "–" || $0 == "—" || $0 == ":" }) ?? stripped.endIndex
        let commandToken = String(stripped[..<commandEnd]).trimmingCharacters(in: CharacterSet(charactersIn: "`"))
        guard commandToken.count > 1 else { return nil }

        let description = String(stripped[commandEnd...])
            .trimmingCharacters(in: .whitespacesAndNewlines)
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
