import Foundation

/// Build the `--config key=value` overlay the macOS app sends to the CLI
/// (`vellum hatch`) during the onboarding hatch step.
///
/// The CLI persists this overlay to a temp JSON file and passes the path to
/// the daemon via `VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH`. At daemon startup,
/// `mergeDefaultWorkspaceConfig` merges it into the workspace config on disk
/// and `seedInferenceProfiles` consumes it via `preserveActiveProfile`.
///
/// Two distinct shapes:
///
/// 1. **Managed-inference path** (`skippedAPIKeyEntry == true`).
///    The user signed in with their Vellum account and chose a non-cloud
///    hosting mode (Local / AWS / GCP / SSH). They did *not* supply a
///    provider API key — chat traffic will route through the managed
///    Anthropic proxy via the platform-injected `assistant_api_key`. Emit
///    `llm.activeProfile = "balanced"` so the seeder preserves the managed
///    profile (which points at `anthropic-managed`) and skips
///    user-profile/personal-connection materialization. Without this the
///    seeder would otherwise pick `custom-balanced` and the daemon would
///    fail to send messages on a missing `credential/anthropic/api_key`.
///
/// 2. **BYOK path** (`skippedAPIKeyEntry == false`).
///    The user entered their own provider API key. Emit
///    `llm.default.provider = <provider>` so the seeder materializes
///    `<provider>-personal` and the matching `custom-*` profiles. The
///    seeder picks `custom-balanced` as the active profile in this case.
///    Preserves historical "default to anthropic when empty" behavior.
func onboardingHatchConfigOverlay(
    skippedAPIKeyEntry: Bool,
    selectedProvider: String,
    defaultProvider: String
) -> [String: String] {
    if skippedAPIKeyEntry {
        return ["llm.activeProfile": "balanced"]
    }
    let provider = selectedProvider.isEmpty ? defaultProvider : selectedProvider
    return ["llm.default.provider": provider]
}
