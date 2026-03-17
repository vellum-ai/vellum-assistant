import SwiftUI

public struct ModelListBubble: View {
    struct ProviderGroup: Identifiable {
        let id: String
        let name: String
        let hasKey: Bool
        let models: [ModelEntry]
    }

    struct ModelEntry: Identifiable {
        let id: String // shortcut command
        let displayName: String
        let isCurrent: Bool
    }

    let currentModel: String
    let configuredProviders: Set<String>

    /// Anthropic model shortcuts, exposed for use by ModelPickerBubble on iOS.
    public static let anthropicModels: [(cmd: String, model: String, display: String)] = [
        ("opus", "claude-opus-4-6", "Claude Opus 4.6"),
        ("sonnet", "claude-sonnet-4-6", "Claude Sonnet 4.6"),
        ("haiku", "claude-haiku-4-5-20251001", "Claude Haiku 4.5"),
    ]

    private static let providerGroups: [(key: String, name: String, models: [(cmd: String, model: String, display: String)])] = [
        ("anthropic", "Anthropic", anthropicModels),
    ]

    private var groups: [ProviderGroup] {
        Self.providerGroups.map { provider in
            let hasKey = configuredProviders.contains(provider.key)
            let entries = provider.models.map { m in
                ModelEntry(
                    id: m.cmd,
                    displayName: m.display,
                    isCurrent: currentModel == m.model
                )
            }
            return ProviderGroup(id: provider.key, name: provider.name, hasKey: hasKey, models: entries)
        }
    }

    public init(currentModel: String, configuredProviders: Set<String>) {
        self.currentModel = currentModel
        self.configuredProviders = configuredProviders
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(groups) { group in
                // Provider header
                HStack(spacing: VSpacing.sm) {
                    Text(group.name)
                        .font(VFont.small)
                        .foregroundColor(VColor.contentTertiary)
                        .tracking(0.5)
                    Spacer()
                    if group.hasKey {
                        Text("connected")
                            .font(VFont.small)
                            .foregroundColor(VColor.systemPositiveStrong)
                    } else {
                        Text("no key")
                            .font(VFont.small)
                            .foregroundColor(VColor.systemNegativeHover)
                    }
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.top, group.id == groups.first?.id ? VSpacing.sm : VSpacing.md)
                .padding(.bottom, VSpacing.xs)

                // Model rows
                ForEach(group.models) { model in
                    HStack(spacing: VSpacing.sm) {
                        if model.isCurrent {
                            VIconView(.circleCheck, size: 11)
                                .foregroundColor(VColor.primaryBase)
                                .frame(width: 16)
                        } else {
                            Color.clear.frame(width: 16, height: 1)
                        }

                        Text(model.displayName)
                            .font(model.isCurrent ? VFont.bodyBold : VFont.body)
                            .foregroundColor(group.hasKey ? VColor.contentDefault : VColor.contentTertiary)

                        Spacer()

                        Text("/\(model.id)")
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.contentTertiary)
                    }
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.xs + 2)
                }
            }

            // Footer
            Text("Switch with /shortcut or `keys set <provider> <key>` to add a provider.")
                .font(VFont.small)
                .foregroundColor(VColor.contentTertiary)
                .padding(.horizontal, VSpacing.lg)
                .padding(.top, VSpacing.md)
                .padding(.bottom, VSpacing.sm)
        }
        .padding(.vertical, VSpacing.xs)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .frame(maxWidth: 480)
    }
}
