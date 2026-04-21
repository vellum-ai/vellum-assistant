import Foundation
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ManagedAssistantIdentityInjection")

/// Client-resolved vellum:* identity fields that must be POSTed to a
/// newly-hatched managed assistant's `/v1/secrets` after hatch. Django's
/// post-hatch provisioning covers the assistant_api_key / platform_base_url /
/// platform_assistant_id / webhook_secret quartet, but the organization id
/// and user id are only known to the signed-in client — they never appear in
/// Django's provisioning payload. Normal local bootstrap covers these via
/// `LocalAssistantBootstrapService.bootstrap()`; teleport-to-platform and the
/// local→managed transfer flow skip that bootstrap, so they must inject
/// these fields directly.
@MainActor
enum ManagedAssistantIdentityInjection {
    /// Inject the client-resolvable `vellum:platform_organization_id` and
    /// `vellum:platform_user_id` into a managed assistant's secret store via
    /// the platform-routed `assistants/<id>/secrets` endpoint.
    ///
    /// The request is routed through `GatewayHTTPClient.withAssistant(_:)` so
    /// it resolves the platform base URL + session token for `assistantId`
    /// rather than for whatever assistant is currently active — teleport
    /// runs while the source (local / docker) assistant is still active, so
    /// the override is required.
    ///
    /// Failures are logged and swallowed: a missing user id is non-fatal
    /// (`platform_user_id` is only used for telemetry / Sentry tagging), and
    /// the org id injection is best-effort since the managed assistant will
    /// still function if the injection misses — it just won't see the
    /// signed-in user's org / user id until the next explicit set.
    static func inject(
        into assistantId: String,
        organizationId: String
    ) async {
        let userId: String?
        do {
            let session = try await AuthService.shared.getSession()
            userId = session.data?.user?.id
        } catch {
            log.warning("Failed to resolve user id before identity injection for \(assistantId, privacy: .public): \(error.localizedDescription, privacy: .public)")
            userId = nil
        }

        await GatewayHTTPClient.withAssistant(assistantId) {
            await postSecret(
                assistantId: assistantId,
                name: "vellum:platform_organization_id",
                value: organizationId
            )
            if let userId, !userId.isEmpty {
                await postSecret(
                    assistantId: assistantId,
                    name: "vellum:platform_user_id",
                    value: userId
                )
            } else {
                log.info("Skipping platform_user_id injection for \(assistantId, privacy: .public) — no user id available")
            }
        }
    }

    private static func postSecret(
        assistantId: String,
        name: String,
        value: String
    ) async {
        let body: [String: Any] = [
            "type": "credential",
            "name": name,
            "value": value,
        ]
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/\(assistantId)/secrets",
                json: body,
                timeout: 10
            )
            if response.isSuccess {
                log.info("Injected \(name, privacy: .public) into \(assistantId, privacy: .public)")
            } else {
                let bodyPreview = String(data: response.data, encoding: .utf8) ?? "<non-utf8>"
                log.warning("Non-OK injecting \(name, privacy: .public) into \(assistantId, privacy: .public): status=\(response.statusCode, privacy: .public) body=\(bodyPreview, privacy: .public)")
            }
        } catch {
            log.warning("Failed to inject \(name, privacy: .public) into \(assistantId, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }
}
