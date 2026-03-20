import Foundation
@preconcurrency import Sentry
import VellumAssistantShared

/// Privacy-safe device identification and Sentry scope configuration.
/// Uses the shared UUID from ~/.vellum/device.json so Sentry device_id
/// matches the daemon telemetry device_id for cross-system correlation.
enum SentryDeviceInfo {
    /// A stable device identifier from the shared device.json file.
    /// Computed once and cached for the process lifetime.
    static let deviceId: String = DeviceIdStore.getOrCreate()

    /// Sentry environment string matching the daemon convention in instrument.ts.
    static let sentryEnvironment: String = {
        #if DEBUG
        return "development"
        #else
        return "production"
        #endif
    }()

    /// Configures the Sentry scope with device and assistant tags.
    /// Call after every `SentrySDK.start` (AppDelegate init, MetricKitManager restart,
    /// manual report temporary start) so all events carry filtering context.
    static func configureSentryScope() {
        SentrySDK.configureScope { scope in
            scope.setTag(value: deviceId, key: "device_id")
            if let storedId = UserDefaults.standard.string(forKey: "connectedAssistantId"),
               LockfileAssistant.loadAll().contains(where: { $0.assistantId == storedId }) {
                scope.setTag(value: storedId, key: "assistant_id")
            } else {
                scope.removeTag(key: "assistant_id")
            }
            if let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId"), !orgId.isEmpty {
                scope.setTag(value: orgId, key: "organization_id")
            } else {
                scope.removeTag(key: "organization_id")
            }
            scope.setTag(value: ProcessInfo.processInfo.operatingSystemVersionString, key: "os_version")
            if let commitSHA = Bundle.main.infoDictionary?["VellumCommitSHA"] as? String, !commitSHA.isEmpty {
                scope.setTag(value: commitSHA, key: "commit")
            }
            if let clientVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
                scope.setTag(value: clientVersion, key: "client_version")
            }
        }
    }

    /// Updates the `assistant_id` Sentry tag when the connected assistant changes.
    /// Call from assistant switch, sign-in, and sign-out flows.
    static func updateAssistantTag(_ assistantId: String?) {
        SentrySDK.configureScope { scope in
            if let id = assistantId {
                scope.setTag(value: id, key: "assistant_id")
            } else {
                scope.removeTag(key: "assistant_id")
            }
        }
    }

    /// Updates the `organization_id` Sentry tag when the connected organization changes.
    static func updateOrganizationTag(_ organizationId: String?) {
        SentrySDK.configureScope { scope in
            if let id = organizationId, !id.isEmpty {
                scope.setTag(value: id, key: "organization_id")
            } else {
                scope.removeTag(key: "organization_id")
            }
        }
    }

    /// Updates the `user_id` Sentry tag when the authenticated user changes.
    static func updateUserTag(_ userId: String?) {
        SentrySDK.configureScope { scope in
            if let id = userId, !id.isEmpty {
                scope.setTag(value: id, key: "user_id")
            } else {
                scope.removeTag(key: "user_id")
            }
        }
    }
}
