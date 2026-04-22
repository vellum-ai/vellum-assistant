import Foundation
import SwiftUI
import VellumAssistantShared
import os

/// Unifies assistant-scoped and macOS-scoped flags so the developer tab can
/// render them in a single list.
private struct UnifiedFeatureFlag: Identifiable, Equatable {
    let id: String
    let key: String
    let label: String
    let description: String
    let defaultEnabled: Bool
    let enabled: Bool
    let scope: FeatureFlagScope
}

/// Developer-tab card for inspecting and toggling feature flags.
///
/// Implemented as a standalone `View` so its body re-evaluates only when its
/// own inputs change, isolating flag rendering from unrelated state elsewhere
/// on the developer tab. The merged+sorted flag list is cached in `@State` and
/// rebuilt only when the underlying flag arrays mutate, keeping the localized
/// sort and allocations off the per-body-pass render path.
@MainActor
struct FeatureFlagsCard: View {
    @Binding var assistantFlags: [AssistantFeatureFlag]
    @Binding var macOSFlagStates: [MacOSFeatureFlagState]
    let assistantFlagsError: String?
    let isLoadingAssistantFlags: Bool
    let featureFlagClient: FeatureFlagClientProtocol

    @State private var searchText: String = ""
    @State private var scopeFilter: String = "all"
    @State private var unifiedFlags: [UnifiedFeatureFlag] = []

    var body: some View {
        SettingsCard(title: "Feature Flags", subtitle: "Toggle feature flags for the assistant and macOS app.") {
            HStack(spacing: VSpacing.sm) {
                VSearchBar(placeholder: "Search flags...", text: $searchText)
                VDropdown(
                    placeholder: "All",
                    selection: $scopeFilter,
                    options: [
                        (label: "All", value: "all"),
                        (label: "Assistant", value: "assistant"),
                        (label: "macOS", value: "macos")
                    ],
                    maxWidth: 130
                )
            }

            if isLoadingAssistantFlags {
                HStack {
                    Spacer()
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                }
            }

            if let error = assistantFlagsError {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.triangleAlert, size: 12)
                        .foregroundStyle(VColor.systemNegativeHover)
                    Text(error)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.systemNegativeStrong)
                }
            }

            let filtered = filteredUnifiedFlags
            if unifiedFlags.isEmpty && !isLoadingAssistantFlags {
                Text("No feature flags available.")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentTertiary)
            } else if filtered.isEmpty && (!searchText.isEmpty || scopeFilter != "all") {
                Text("No matching flags.")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentTertiary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        ForEach(filtered) { flag in
                            unifiedFlagRow(flag: flag)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 400)
            }
        }
        .onAppear { rebuildUnifiedFlags() }
        .onChange(of: assistantFlags) { _, _ in rebuildUnifiedFlags() }
        .onChange(of: macOSFlagStates) { _, _ in rebuildUnifiedFlags() }
    }

    private var filteredUnifiedFlags: [UnifiedFeatureFlag] {
        var flags = unifiedFlags
        if scopeFilter == "assistant" {
            flags = flags.filter { $0.scope == .assistant }
        } else if scopeFilter == "macos" {
            flags = flags.filter { $0.scope == .macos }
        }
        if !searchText.isEmpty {
            flags = flags.filter { flag in
                flag.label.localizedCaseInsensitiveContains(searchText) ||
                flag.description.localizedCaseInsensitiveContains(searchText) ||
                flag.key.localizedCaseInsensitiveContains(searchText)
            }
        }
        return flags
    }

    private func rebuildUnifiedFlags() {
        unifiedFlags = Self.buildUnifiedFlags(
            assistantFlags: assistantFlags,
            macOSFlagStates: macOSFlagStates
        )
    }

    /// Merge assistant-scoped and macOS-scoped flags into a single sorted list.
    /// If a flag key exists in both scopes, the macOS entry wins and the
    /// assistant duplicate is dropped.
    static func buildUnifiedFlags(
        assistantFlags: [AssistantFeatureFlag],
        macOSFlagStates: [MacOSFeatureFlagState]
    ) -> [UnifiedFeatureFlag] {
        let fromAssistant: [UnifiedFeatureFlag] = assistantFlags.map { flag in
            UnifiedFeatureFlag(
                id: flag.key,
                key: flag.key,
                label: flag.displayName,
                description: flag.description ?? "",
                defaultEnabled: flag.defaultEnabled ?? true,
                enabled: flag.enabled,
                scope: .assistant
            )
        }
        let fromMacOS: [UnifiedFeatureFlag] = macOSFlagStates.map { state in
            UnifiedFeatureFlag(
                id: state.key,
                key: state.key,
                label: state.label,
                description: state.description,
                defaultEnabled: state.defaultEnabled,
                enabled: state.enabled,
                scope: .macos
            )
        }
        let macOSKeys = Set(fromMacOS.map { $0.key })
        let dedupedAssistant = fromAssistant.filter { !macOSKeys.contains($0.key) }
        return (dedupedAssistant + fromMacOS)
            .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
    }

    private func unifiedFlagRow(flag: UnifiedFeatureFlag) -> some View {
        let flagBinding = Binding<Bool>(
            get: {
                switch flag.scope {
                case .assistant:
                    return assistantFlags.first(where: { $0.key == flag.key })?.enabled ?? flag.enabled
                case .macos:
                    return macOSFlagStates.first(where: { $0.key == flag.key })?.enabled ?? flag.enabled
                }
            },
            set: { newValue in
                switch flag.scope {
                case .assistant:
                    setAssistantFlag(key: flag.key, enabled: newValue, flag: flag)
                case .macos:
                    setMacOSFlag(key: flag.key, enabled: newValue)
                }
            }
        )
        return HStack(alignment: .top, spacing: VSpacing.sm) {
            VToggle(isOn: flagBinding)
                .accessibilityLabel(flag.label)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack(spacing: VSpacing.xs) {
                    Text(flag.label)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                    VBadge(label: flag.scope == .assistant ? "Assistant" : "macOS",
                           tone: flag.scope == .assistant ? .accent : .neutral,
                           emphasis: .subtle)
                }
                if !flag.description.isEmpty {
                    Text(flag.description)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
                HStack(spacing: VSpacing.xxs) {
                    Text("Default:")
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentTertiary)
                    VBadge(label: flag.defaultEnabled ? "On" : "Off",
                           tone: flag.defaultEnabled ? .danger : .neutral,
                           emphasis: .subtle)
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation { flagBinding.wrappedValue.toggle() } }
    }

    private func setAssistantFlag(key: String, enabled newValue: Bool, flag: UnifiedFeatureFlag) {
        let previousValue = assistantFlags.first(where: { $0.key == key })?.enabled ?? flag.enabled
        if let index = assistantFlags.firstIndex(where: { $0.key == key }) {
            assistantFlags[index] = AssistantFeatureFlag(
                key: key,
                enabled: newValue,
                defaultEnabled: flag.defaultEnabled,
                description: flag.description.isEmpty ? nil : flag.description,
                label: flag.label
            )
        }
        NotificationCenter.default.post(
            name: .assistantFeatureFlagDidChange,
            object: nil,
            userInfo: ["key": key, "enabled": newValue]
        )
        AssistantFeatureFlagResolver.mergeCachedFlag(key: key, enabled: newValue)
        Task {
            do {
                try await featureFlagClient.setFeatureFlag(key: key, enabled: newValue)
            } catch {
                await MainActor.run {
                    guard let index = assistantFlags.firstIndex(where: { $0.key == key }) else { return }
                    // A newer user toggle may have superseded this request; don't clobber it.
                    guard assistantFlags[index].enabled == newValue else { return }
                    assistantFlags[index] = AssistantFeatureFlag(
                        key: key,
                        enabled: previousValue,
                        defaultEnabled: flag.defaultEnabled,
                        description: flag.description.isEmpty ? nil : flag.description,
                        label: flag.label
                    )
                    NotificationCenter.default.post(
                        name: .assistantFeatureFlagDidChange,
                        object: nil,
                        userInfo: ["key": key, "enabled": previousValue]
                    )
                    AssistantFeatureFlagResolver.mergeCachedFlag(key: key, enabled: previousValue)
                }
                os.Logger(subsystem: Bundle.appBundleIdentifier, category: "FeatureFlags")
                    .warning("Failed to sync feature flag '\(key)' to gateway; reverted local toggle: \(error.localizedDescription)")
            }
        }
    }

    private func setMacOSFlag(key: String, enabled newValue: Bool) {
        if let index = macOSFlagStates.firstIndex(where: { $0.key == key }) {
            macOSFlagStates[index].enabled = newValue
        }
        MacOSClientFeatureFlagManager.shared.setOverride(key, enabled: newValue)
        NotificationCenter.default.post(
            name: .assistantFeatureFlagDidChange,
            object: nil,
            userInfo: ["key": key, "enabled": newValue]
        )
    }
}
