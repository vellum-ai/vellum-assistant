import SwiftUI

public struct ModelListBubble: View {
    struct ProviderGroup: Identifiable {
        let id: String
        let name: String
        let hasKey: Bool
        let models: [ModelEntry]
    }

    struct ModelEntry: Identifiable {
        let id: String
        let displayName: String
        let isCurrent: Bool
    }

    let currentModel: String
    let configuredProviders: Set<String>
    let providerCatalog: [ProviderCatalogEntry]

    private var groups: [ProviderGroup] {
        providerCatalog.map { provider in
            let hasKey = configuredProviders.contains(provider.id)
            let entries = provider.models.map { m in
                ModelEntry(
                    id: m.id,
                    displayName: m.displayName,
                    isCurrent: currentModel == m.id
                )
            }
            return ProviderGroup(id: provider.id, name: provider.displayName, hasKey: hasKey, models: entries)
        }
    }

    public init(currentModel: String, configuredProviders: Set<String>, providerCatalog: [ProviderCatalogEntry]) {
        self.currentModel = currentModel
        self.configuredProviders = configuredProviders
        self.providerCatalog = providerCatalog
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

                        Text(model.id)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.contentTertiary)
                    }
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.xs + 2)
                }
            }

            // Footer
            Text("Use Settings -> Models & Services to switch models, or `keys set <provider> <key>` to add a provider.")
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
