import SwiftUI

public struct CommandListBubble: View {
    struct CommandEntry: Identifiable {
        let id: String // slash command
        let description: String
    }

    private let commands: [CommandEntry] = [
        CommandEntry(id: "/commands", description: "Show this list"),
        CommandEntry(id: "/model", description: "Show or switch the current model"),
        CommandEntry(id: "/models", description: "List all available models"),
    ]

    public init() {}

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
}
