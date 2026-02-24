import SwiftUI
import VellumAssistantShared

/// Appearance settings tab — theme selection and media embed configuration.
struct SettingsAppearanceTab: View {
    @ObservedObject var store: SettingsStore
    @AppStorage("themePreference") private var themePreference: String = "system"
    @State private var newAllowlistDomain = ""

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            // DISPLAY section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Display")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                HStack {
                    Text("Theme")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    Picker("", selection: Binding(
                        get: { themePreference },
                        set: { newValue in
                            themePreference = newValue
                            AppDelegate.shared?.applyThemePreference()
                        }
                    )) {
                        Text("System").tag("system")
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 200)
                }

            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)

            // MEDIA EMBEDS section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Media Embeds")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                HStack {
                    Text("Auto media embeds")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    Toggle("", isOn: Binding(
                        get: { store.mediaEmbedsEnabled },
                        set: { store.setMediaEmbedsEnabled($0) }
                    ))
                    .toggleStyle(.switch)
                    .labelsHidden()
                }

                Text("Automatically embed images, videos, and other media shared in chat messages.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)

                if store.mediaEmbedsEnabled {
                    Divider()
                        .background(VColor.surfaceBorder)

                    Text("Video Domain Allowlist")
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.textSecondary)

                    HStack(spacing: VSpacing.sm) {
                        TextField("Add domain (e.g. example.com)", text: $newAllowlistDomain)
                            .vInputStyle()

                        VButton(label: "Add", style: .primary) {
                            let domain = newAllowlistDomain
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                            guard !domain.isEmpty else { return }
                            var domains = store.mediaEmbedVideoAllowlistDomains
                            domains.append(domain)
                            store.setMediaEmbedVideoAllowlistDomains(domains)
                            newAllowlistDomain = ""
                        }
                    }

                    ForEach(store.mediaEmbedVideoAllowlistDomains, id: \.self) { domain in
                        HStack {
                            Text(domain)
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            Spacer()
                            Button {
                                var domains = store.mediaEmbedVideoAllowlistDomains
                                domains.removeAll { $0 == domain }
                                store.setMediaEmbedVideoAllowlistDomains(domains)
                            } label: {
                                Image(systemName: "trash")
                                    .foregroundColor(VColor.error)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.vertical, VSpacing.xs)
                    }

                    HStack {
                        Spacer()
                        VButton(label: "Reset to Defaults", style: .tertiary) {
                            store.setMediaEmbedVideoAllowlistDomains(MediaEmbedSettings.defaultDomains)
                        }
                    }
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)
        }
    }
}
