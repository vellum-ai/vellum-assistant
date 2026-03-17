import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppClient")

/// Focused client for app management operations routed through the gateway.
@MainActor
public protocol AppClientProtocol {
    func fetchList() async -> AppsListResponse?
    func open(appId: String) async -> UiSurfaceShowMessage?
    func updatePreview(appId: String, preview: String) async -> Bool
    func fetchPreview(appId: String) async -> AppPreviewResponse?
    func fetchHistory(appId: String, limit: Int?) async -> AppHistoryResponse?
    func fetchDiff(appId: String, fromCommit: String, toCommit: String?) async -> AppDiffResponse?
    func restore(appId: String, commitHash: String) async -> AppRestoreResponse?
    func bundle(appId: String) async -> BundleAppResponse?
    func openBundle(filePath: String) async -> OpenBundleResponse?
    func fetchSharedList() async -> SharedAppsListResponse?
    func delete(appId: String) async -> AppDeleteResponse?
    func deleteShared(uuid: String) async -> SharedAppDeleteResponse?
}

/// Gateway-backed implementation of ``AppClientProtocol``.
@MainActor
public struct AppClient: AppClientProtocol {
    nonisolated public init() {}

    public func fetchList() async -> AppsListResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/apps",
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchList failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("apps_list_response", into: response.data)
            return try JSONDecoder().decode(AppsListResponse.self, from: patched)
        } catch {
            log.error("fetchList error: \(error.localizedDescription)")
            return nil
        }
    }

    public func open(appId: String) async -> UiSurfaceShowMessage? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/apps/\(appId)/open",
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("open failed (HTTP \(response.statusCode))")
                return nil
            }
            let rest = try JSONDecoder().decode(RESTAppOpenResponse.self, from: response.data)
            let surfaceId = "app-\(rest.appId)"
            return UiSurfaceShowMessage(
                conversationId: nil,
                surfaceId: surfaceId,
                surfaceType: "dynamic_page",
                title: rest.name,
                data: AnyCodable(["html": rest.html, "appId": rest.appId]),
                actions: nil,
                display: "panel",
                messageId: nil
            )
        } catch {
            log.error("open error: \(error.localizedDescription)")
            return nil
        }
    }

    public func updatePreview(appId: String, preview: String) async -> Bool {
        do {
            let response = try await GatewayHTTPClient.put(
                path: "assistants/{assistantId}/apps/\(appId)/preview",
                json: ["preview": preview],
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("updatePreview failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("updatePreview error: \(error.localizedDescription)")
            return false
        }
    }

    public func fetchPreview(appId: String) async -> AppPreviewResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/apps/\(appId)/preview",
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchPreview failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("app_preview_response", into: response.data)
            return try JSONDecoder().decode(AppPreviewResponse.self, from: patched)
        } catch {
            log.error("fetchPreview error: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchHistory(appId: String, limit: Int? = nil) async -> AppHistoryResponse? {
        do {
            var params: [String: String] = [:]
            if let limit { params["limit"] = "\(limit)" }

            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/apps/\(appId)/history",
                params: params.isEmpty ? nil : params,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchHistory failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("app_history_response", into: response.data)
            return try JSONDecoder().decode(AppHistoryResponse.self, from: patched)
        } catch {
            log.error("fetchHistory error: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchDiff(appId: String, fromCommit: String, toCommit: String? = nil) async -> AppDiffResponse? {
        do {
            var params: [String: String] = ["fromCommit": fromCommit]
            if let toCommit { params["toCommit"] = toCommit }

            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/apps/\(appId)/diff",
                params: params,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchDiff failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("app_diff_response", into: response.data)
            return try JSONDecoder().decode(AppDiffResponse.self, from: patched)
        } catch {
            log.error("fetchDiff error: \(error.localizedDescription)")
            return nil
        }
    }

    public func restore(appId: String, commitHash: String) async -> AppRestoreResponse? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/apps/\(appId)/restore",
                json: ["commitHash": commitHash],
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("restore failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("app_restore_response", into: response.data)
            return try JSONDecoder().decode(AppRestoreResponse.self, from: patched)
        } catch {
            log.error("restore error: \(error.localizedDescription)")
            return nil
        }
    }

    public func bundle(appId: String) async -> BundleAppResponse? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/apps/\(appId)/bundle",
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("bundle failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("bundle_app_response", into: response.data)
            return try JSONDecoder().decode(BundleAppResponse.self, from: patched)
        } catch {
            log.error("bundle error: \(error.localizedDescription)")
            return nil
        }
    }

    public func openBundle(filePath: String) async -> OpenBundleResponse? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/apps/open-bundle",
                json: ["filePath": filePath],
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("openBundle failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("open_bundle_response", into: response.data)
            return try JSONDecoder().decode(OpenBundleResponse.self, from: patched)
        } catch {
            log.error("openBundle error: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchSharedList() async -> SharedAppsListResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/apps/shared",
                timeout: 10
            )
            if response.statusCode == 404 {
                return SharedAppsListResponse(type: "shared_apps_list_response", apps: [])
            }
            guard response.isSuccess else {
                log.error("fetchSharedList failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("shared_apps_list_response", into: response.data)
            return try JSONDecoder().decode(SharedAppsListResponse.self, from: patched)
        } catch {
            log.error("fetchSharedList error: \(error.localizedDescription)")
            return nil
        }
    }

    public func delete(appId: String) async -> AppDeleteResponse? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/apps/\(appId)/delete",
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("delete failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("app_delete_response", into: response.data)
            return try JSONDecoder().decode(AppDeleteResponse.self, from: patched)
        } catch {
            log.error("delete error: \(error.localizedDescription)")
            return nil
        }
    }

    public func deleteShared(uuid: String) async -> SharedAppDeleteResponse? {
        do {
            let response = try await GatewayHTTPClient.delete(
                path: "assistants/{assistantId}/apps/shared/\(uuid)",
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("deleteShared failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("shared_app_delete_response", into: response.data)
            return try JSONDecoder().decode(SharedAppDeleteResponse.self, from: patched)
        } catch {
            log.error("deleteShared error: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Helpers

    private struct RESTAppOpenResponse: Decodable {
        let appId: String
        let name: String
        let html: String
    }

    private func injectType(_ type: String, into data: Data) -> Data {
        guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return data
        }
        json["type"] = type
        return (try? JSONSerialization.data(withJSONObject: json)) ?? data
    }
}
