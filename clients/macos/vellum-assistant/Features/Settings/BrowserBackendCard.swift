import AppKit
import SwiftUI
import VellumAssistantShared

/// Developer-only card that lets the user route browser tool calls through a
/// host Chrome instance launched with `--remote-debugging-port` (the
/// cdp-inspect host-browser backend).
///
/// This is an **advanced** mode: once enabled, the assistant can see and act
/// on any tab in the user's real Chrome profile, so the card leads with a
/// prominent security warning and only allows loopback host overrides.
@MainActor
struct BrowserBackendCard: View {
    @ObservedObject var store: SettingsStore

    /// Local draft of the host value — only persisted on Save.
    @State private var draftHost: String = "localhost"
    /// Local draft of the port value — only persisted on Save.
    @State private var draftPortText: String = "9222"
    @State private var hostError: String?
    @State private var portError: String?
    @FocusState private var isHostFocused: Bool
    @FocusState private var isPortFocused: Bool

    /// Docs URL for the "use your own Chrome" backend. Routed through
    /// `AppURLs.browserCdpInspectDocs` so it honors `VELLUM_DOCS_BASE_URL`
    /// overrides (staging / local docs servers) — see
    /// `clients/macos/AGENTS.md` § External URLs. The real docs page lands
    /// with a later PR so the slug is a placeholder.
    private static var learnMoreURL: URL {
        AppURLs.browserCdpInspectDocs
    }

    var body: some View {
        SettingsCard(
            title: "Use your own Chrome (Advanced)",
            subtitle: "Route the assistant's browser tools through a Chrome instance you launched with remote debugging. For advanced users only."
        ) {
            warningBlock

            SettingsDivider()

            VToggle(
                isOn: Binding(
                    get: { store.hostBrowserCdpInspectEnabled },
                    set: { newValue in
                        _ = store.setHostBrowserCdpInspectEnabled(newValue)
                    }
                ),
                label: "Enable cdp-inspect backend",
                helperText: "When on, the assistant probes the host/port below before falling back to the managed browser."
            )
            .accessibilityLabel("Enable cdp-inspect backend")

            if store.hostBrowserCdpInspectEnabled {
                connectionForm
            }

            learnMoreLink
        }
        .onAppear {
            syncDraftsFromStore()
        }
        .onChange(of: store.hostBrowserCdpInspectHost) { _, newValue in
            if !isHostFocused {
                draftHost = newValue
                hostError = nil
            }
        }
        .onChange(of: store.hostBrowserCdpInspectPort) { _, newValue in
            if !isPortFocused {
                draftPortText = String(newValue)
                portError = nil
            }
        }
    }

    // MARK: - Warning Block

    private var warningBlock: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            VIconView(.triangleAlert, size: 16)
                .foregroundStyle(VColor.systemNegativeStrong)
                .padding(.top, 1)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Warning: This mode gives the assistant full control of your real Chrome profile.")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentEmphasized)

                Text(
                    "When enabled, the assistant can read and act on any tab in your real Chrome, including sites you're already signed into (email, banking, chat). The DOM content it observes comes from untrusted web pages, so a malicious page could try to manipulate what the assistant sees or does."
                )
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
                .fixedSize(horizontal: false, vertical: true)

                Text("Connections are limited to localhost (no remote attach). Only enable this if you understand the risks.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(VSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(VColor.systemNegativeWeak)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    // MARK: - Connection Form

    private var connectionForm: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Host")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
                VTextField(
                    placeholder: "localhost",
                    text: $draftHost,
                    errorMessage: hostError,
                    isFocused: $isHostFocused
                )
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Port")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
                VTextField(
                    placeholder: "9222",
                    text: $draftPortText,
                    errorMessage: portError,
                    isFocused: $isPortFocused
                )
            }

            HStack {
                VButton(
                    label: "Save",
                    style: .primary,
                    isDisabled: !hasFormChanges
                ) {
                    saveFormChanges()
                }
            }

            Text("Only loopback addresses (localhost, 127.0.0.1, ::1, [::1]) are accepted. Ports must be between 1 and 65535.")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
    }

    // MARK: - Learn more

    private var learnMoreLink: some View {
        Button {
            NSWorkspace.shared.open(Self.learnMoreURL)
        } label: {
            HStack(spacing: VSpacing.xxs) {
                VIconView(.info, size: 12)
                Text("Learn more about the security risks")
                    .font(VFont.labelDefault)
            }
            .foregroundStyle(VColor.primaryBase)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Learn more about the security risks")
    }

    // MARK: - Drafts / Saving

    private var hasFormChanges: Bool {
        let trimmedHost = draftHost.trimmingCharacters(in: .whitespacesAndNewlines)
        let parsedPort = Int(draftPortText.trimmingCharacters(in: .whitespacesAndNewlines))
        let hostChanged = trimmedHost != store.hostBrowserCdpInspectHost
        let portChanged = parsedPort != store.hostBrowserCdpInspectPort
        return hostChanged || portChanged
    }

    private func syncDraftsFromStore() {
        draftHost = store.hostBrowserCdpInspectHost
        draftPortText = String(store.hostBrowserCdpInspectPort)
        hostError = nil
        portError = nil
    }

    private func saveFormChanges() {
        // Validate BOTH host and port before applying any patches so the save
        // path is atomic: if either field is invalid, we surface all errors
        // and persist neither change. Previously, host-only failures still
        // silently persisted the port, leaving the form in a partially-applied
        // state that was hard to reason about.
        let trimmedHost = draftHost.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPortText = draftPortText.trimmingCharacters(in: .whitespacesAndNewlines)

        var pendingHostError: String?
        var pendingPortError: String?

        let hostChanged = trimmedHost != store.hostBrowserCdpInspectHost
        if hostChanged, !SettingsStore.isValidHostBrowserCdpInspectHost(trimmedHost) {
            pendingHostError = "Only loopback hosts are allowed (localhost, 127.0.0.1, ::1, [::1])."
        }

        let parsedPort = Int(trimmedPortText)
        let portChanged: Bool
        if let parsedPort {
            portChanged = parsedPort != store.hostBrowserCdpInspectPort
            if portChanged, !SettingsStore.isValidHostBrowserCdpInspectPort(parsedPort) {
                pendingPortError = "Port must be between 1 and 65535."
            }
        } else {
            portChanged = false
            pendingPortError = "Port must be a number between 1 and 65535."
        }

        // Publish both error slots in one pass so the user sees every issue at
        // once rather than fixing them sequentially.
        hostError = pendingHostError
        portError = pendingPortError

        if pendingHostError != nil || pendingPortError != nil {
            // Validation failed — do not mutate the store or emit any patches.
            return
        }

        // All validation passed — apply only the fields that actually changed.
        // The setters run their own validation too, but we've already checked
        // it above so they should return nil. If they don't, we surface the
        // error instead of silently swallowing it.
        if hostChanged {
            if let error = store.setHostBrowserCdpInspectHost(trimmedHost) {
                hostError = error
                return
            }
        }
        if portChanged, let parsedPort {
            if let error = store.setHostBrowserCdpInspectPort(parsedPort) {
                portError = error
                return
            }
        }

        isHostFocused = false
        isPortFocused = false
    }
}
