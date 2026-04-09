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

    /// Placeholder docs URL. The real docs page lands with the browser CDP
    /// inspect docs PR so the exact slug may change before the docs ship.
    private static let learnMoreURL = URL(
        string: "https://docs.vellum.ai/assistant/browser/use-your-own-chrome"
    )

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
            if let url = Self.learnMoreURL {
                NSWorkspace.shared.open(url)
            }
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
        let trimmedHost = draftHost.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPortText = draftPortText.trimmingCharacters(in: .whitespacesAndNewlines)

        var blockedByValidation = false

        if trimmedHost != store.hostBrowserCdpInspectHost {
            if let error = store.setHostBrowserCdpInspectHost(trimmedHost) {
                hostError = error
                blockedByValidation = true
            } else {
                hostError = nil
            }
        } else {
            hostError = nil
        }

        if let parsedPort = Int(trimmedPortText) {
            if parsedPort != store.hostBrowserCdpInspectPort {
                if let error = store.setHostBrowserCdpInspectPort(parsedPort) {
                    portError = error
                    blockedByValidation = true
                } else {
                    portError = nil
                }
            } else {
                portError = nil
            }
        } else {
            portError = "Port must be a number between 1 and 65535."
            blockedByValidation = true
        }

        if !blockedByValidation {
            isHostFocused = false
            isPortFocused = false
        }
    }
}
