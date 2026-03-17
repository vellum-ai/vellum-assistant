import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppsClient")

/// Focused client for apps-related operations routed through the gateway.
///
/// Covers listing, opening, deleting, previewing, bundling, sharing, and
/// version history for both local and shared apps.
@MainActor
public protocol AppsClientProtocol {
    func fetchAppsList() async -> AppsListResponse?
    func openApp(id: String) async -> AppOpenResult?
    func deleteApp(id: String) async -> AppDeleteResponse?
    func fetchAppPreview(appId: String) async -> AppPreviewResponse?
    func updateAppPreview(appId: String, preview: String) async -> AppUpdatePreviewResponse?
    func bundleApp(appId: String) async -> BundleAppResponse?
    func openBundle(filePath: String) async -> OpenBundleResponse?
    func fetchAppHistory(appId: String, limit: Int?) async -> AppHistoryResponse?
    func fetchAppDiff(appId: String, fromCommit: String, toCommit: String?) async -> AppDiffResponse?
    func restoreApp(appId: String, commitHash: String) async -> AppRestoreResponse?
    func fetchSharedAppsList() async -> SharedAppsListResponse?
    func deleteSharedApp(uuid: String) async -> SharedAppDeleteResponse?
    func forkSharedApp(uuid: String) async -> ForkSharedAppResponseMessage?
    func shareAppCloud(appId: String) async -> ShareAppCloudResponse?
    func fetchAppData(appId: String, method: String, recordId: String?, data: [String: AnyCodable]?, surfaceId: String, callId: String) async -> AppDataResponse?
}

/// REST shape returned by `/v1/apps/:id/open`.
public struct AppOpenResult: Sendable {
    public let appId: String
    public let name: String
    public let html: String
}

/// Gateway-backed implementation of ``AppsClientProtocol``.
@MainActor
public struct AppsClient: AppsClientProtocol {
    nonisolated public init() {}

    // MARK: - REST Response Shapes

    private struct HTTPAppsListResponse: Decodable {
        let apps: [HTTPAppsListItem]
    }

    private struct HTTPAppsListItem: Decodable {
        let id: String
        let name: String
        let description: String?
        let icon: String?
        let preview: String?
        let createdAt: Int
        let version: String?
        let contentId: String?
    }

    private struct HTTPSharedAppsListResponse: Decodable {
        let apps: [HTTPSharedAppsListItem]
    }

    private struct HTTPSharedAppsListItem: Decodable {
        let uuid: String
        let name: String
        let description: String?
        let icon: String?
        let preview: String?
        let entry: String
        let trustTier: String
        let signerDisplayName: String?
        let bundleSizeBytes: Int
        let installedAt: String
        let version: String?
        let contentId: String?
        let updateAvailable: Bool?
    }

    private struct HTTPAppOpenResponse: Decodable {
        let appId: String
        let name: String
        let html: String
    }

    private struct RESTAppDataResponse: Decodable {
        let success: Bool
        let result: AnyCodable?
        let error: String?
    }

    // MARK: - Local Apps

    public func fetchAppsList() async -> AppsListResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/apps", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchAppsList failed (HTTP \(response.statusCode))")
                return AppsListResponse(
                    type: "apps_list_response", apps: [], success: false
                )
            }
            let decoded = try JSONDecoder().decode(HTTPAppsListResponse.self, from: response.data)
            let apps = decoded.apps.map { app in
                AppsListResponseApp(
                    id: app.id,
                    name: app.name,
                    description: app.description,
                    icon: app.icon,
                    preview: app.preview,
                    createdAt: app.createdAt,
                    version: app.version,
                    contentId: app.contentId
                )
            }
            return AppsListResponse(
                type: "apps_list_response", apps: apps
            )
        } catch {
            log.error("fetchAppsList error: \(error.localizedDescription)")
            return AppsListResponse(
                type: "apps_list_response", apps: [], success: false
            )
        }
    }

    public func openApp(id: String) async -> AppOpenResult? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/apps/\(id)/open", timeout: 10
            )
            guard response.isSuccess else {
                log.error("openApp failed (HTTP \(response.statusCode))")
                return nil
            }
            let decoded = try JSONDecoder().decode(HTTPAppOpenResponse.self, from: response.data)
            return AppOpenResult(appId: decoded.appId, name: decoded.name, html: decoded.html)
        } catch {
            log.error("openApp error: \(error.localizedDescription)")
            return nil
        }
    }

    /// Open an app and dispatch the resulting surface through the daemon's
    /// message router so the workspace pipeline is triggered.
    public static func openAppAndDispatchSurface(id: String, daemonClient: DaemonClient) async {
        let result = await AppsClient().openApp(id: id)
        guard let result else { return }
        let surfaceMsg = UiSurfaceShowMessage(
            conversationId: "app-open",
            surfaceId: "app-open-\(result.appId)",
            surfaceType: "dynamic_page",
            title: result.name,
            data: AnyCodable(["html": result.html, "appId": result.appId]),
            actions: nil,
            display: "panel",
            messageId: nil
        )
        await MainActor.run {
            daemonClient.handleServerMessage(.uiSurfaceShow(surfaceMsg))
        }
    }

    public func deleteApp(id: String) async -> AppDeleteResponse? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/apps/\(id)/delete", timeout: 10
            )
            guard response.isSuccess else {
                log.error("deleteApp failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("app_delete_response", into: response.data)
            return try JSONDecoder().decode(AppDeleteResponse.self, from: patched)
        } catch {
            log.error("deleteApp error: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchAppPreview(appId: String) async -> AppPreviewResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/apps/\(appId)/preview", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchAppPreview failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("app_preview_response", into: response.data)
            return try JSONDecoder().decode(AppPreviewResponse.self, from: patched)
        } catch {
            log.error("fetchAppPreview error: \(error.localizedDescription)")
            return nil
        }
    }

    public func updateAppPreview(appId: String, preview: String) async -> AppUpdatePreviewResponse? {
        do {
            let body: [String: Any] = ["preview": preview]
            let response = try await GatewayHTTPClient.put(
                path: "assistants/{assistantId}/apps/\(appId)/preview", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("updateAppPreview failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("app_update_preview_response", into: response.data)
            return try JSONDecoder().decode(AppUpdatePreviewResponse.self, from: patched)
        } catch {
            log.error("updateAppPreview error: \(error.localizedDescription)")
            return nil
        }
    }

    public func bundleApp(appId: String) async -> BundleAppResponse? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/apps/\(appId)/bundle", timeout: 10
            )
            guard response.isSuccess else {
                log.error("bundleApp failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("bundle_app_response", into: response.data)
            return try JSONDecoder().decode(BundleAppResponse.self, from: patched)
        } catch {
            log.error("bundleApp error: \(error.localizedDescription)")
            return nil
        }
    }

    public func openBundle(filePath: String) async -> OpenBundleResponse? {
        do {
            let body: [String: Any] = ["filePath": filePath]
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/apps/open-bundle", json: body, timeout: 10
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

    public func fetchAppHistory(appId: String, limit: Int? = nil) async -> AppHistoryResponse? {
        do {
            var params: [String: String] = [:]
            if let limit { params["limit"] = String(limit) }

            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/apps/\(appId)/history",
                params: params.isEmpty ? nil : params,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchAppHistory failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("app_history_response", into: response.data)
            return try JSONDecoder().decode(AppHistoryResponse.self, from: patched)
        } catch {
            log.error("fetchAppHistory error: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchAppDiff(appId: String, fromCommit: String, toCommit: String? = nil) async -> AppDiffResponse? {
        do {
            var params: [String: String] = ["fromCommit": fromCommit]
            if let toCommit { params["toCommit"] = toCommit }

            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/apps/\(appId)/diff",
                params: params,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchAppDiff failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("app_diff_response", into: response.data)
            return try JSONDecoder().decode(AppDiffResponse.self, from: patched)
        } catch {
            log.error("fetchAppDiff error: \(error.localizedDescription)")
            return nil
        }
    }

    public func restoreApp(appId: String, commitHash: String) async -> AppRestoreResponse? {
        do {
            let body: [String: Any] = ["commitHash": commitHash]
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/apps/\(appId)/restore", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("restoreApp failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("app_restore_response", into: response.data)
            return try JSONDecoder().decode(AppRestoreResponse.self, from: patched)
        } catch {
            log.error("restoreApp error: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Shared Apps

    public func fetchSharedAppsList() async -> SharedAppsListResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/apps/shared", timeout: 10
            )
            if response.statusCode == 404 {
                // Older assistants may not expose the shared-apps route yet.
                return SharedAppsListResponse(
                    type: "shared_apps_list_response", apps: []
                )
            }
            guard response.isSuccess else {
                log.error("fetchSharedAppsList failed (HTTP \(response.statusCode))")
                return SharedAppsListResponse(
                    type: "shared_apps_list_response", apps: []
                )
            }
            let decoded = try JSONDecoder().decode(HTTPSharedAppsListResponse.self, from: response.data)
            let apps = decoded.apps.map { app in
                SharedAppsListResponseApp(
                    uuid: app.uuid,
                    name: app.name,
                    description: app.description,
                    icon: app.icon,
                    preview: app.preview,
                    entry: app.entry,
                    trustTier: app.trustTier,
                    signerDisplayName: app.signerDisplayName,
                    bundleSizeBytes: app.bundleSizeBytes,
                    installedAt: app.installedAt,
                    version: app.version,
                    contentId: app.contentId,
                    updateAvailable: app.updateAvailable
                )
            }
            return SharedAppsListResponse(
                type: "shared_apps_list_response", apps: apps
            )
        } catch {
            log.error("fetchSharedAppsList error: \(error.localizedDescription)")
            return SharedAppsListResponse(
                type: "shared_apps_list_response", apps: []
            )
        }
    }

    public func deleteSharedApp(uuid: String) async -> SharedAppDeleteResponse? {
        do {
            let response = try await GatewayHTTPClient.delete(
                path: "assistants/{assistantId}/apps/shared/\(uuid)", timeout: 10
            )
            guard response.isSuccess else {
                log.error("deleteSharedApp failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("shared_app_delete_response", into: response.data)
            return try JSONDecoder().decode(SharedAppDeleteResponse.self, from: patched)
        } catch {
            log.error("deleteSharedApp error: \(error.localizedDescription)")
            return nil
        }
    }

    public func forkSharedApp(uuid: String) async -> ForkSharedAppResponseMessage? {
        do {
            let body: [String: Any] = ["uuid": uuid]
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/apps/fork", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("forkSharedApp failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("fork_shared_app_response", into: response.data)
            return try JSONDecoder().decode(ForkSharedAppResponseMessage.self, from: patched)
        } catch {
            log.error("forkSharedApp error: \(error.localizedDescription)")
            return nil
        }
    }

    public func shareAppCloud(appId: String) async -> ShareAppCloudResponse? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/apps/\(appId)/share-cloud", timeout: 10
            )
            guard response.isSuccess else {
                log.error("shareAppCloud failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("share_app_cloud_response", into: response.data)
            return try JSONDecoder().decode(ShareAppCloudResponse.self, from: patched)
        } catch {
            log.error("shareAppCloud error: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - App Data

    public func fetchAppData(appId: String, method: String, recordId: String? = nil, data: [String: AnyCodable]? = nil, surfaceId: String, callId: String) async -> AppDataResponse? {
        let isQuery = method == "query" || method == "get"

        do {
            let response: GatewayHTTPClient.Response
            if isQuery {
                var params: [String: String] = ["method": method]
                if let recordId { params["recordId"] = recordId }
                response = try await GatewayHTTPClient.get(
                    path: "assistants/{assistantId}/apps/\(appId)/data",
                    params: params,
                    timeout: 10
                )
            } else {
                var body: [String: Any] = ["method": method]
                if let recordId { body["recordId"] = recordId }
                if let data {
                    var rawData: [String: Any] = [:]
                    for (key, value) in data {
                        rawData[key] = value.value
                    }
                    body["data"] = rawData
                }
                response = try await GatewayHTTPClient.post(
                    path: "assistants/{assistantId}/apps/\(appId)/data",
                    json: body,
                    timeout: 10
                )
            }
            guard response.isSuccess else {
                log.error("fetchAppData failed (HTTP \(response.statusCode))")
                return nil
            }
            let rest = try JSONDecoder().decode(RESTAppDataResponse.self, from: response.data)
            return AppDataResponse(
                type: "app_data_response",
                surfaceId: surfaceId,
                callId: callId,
                success: rest.success,
                result: rest.result,
                error: rest.error
            )
        } catch {
            log.error("fetchAppData error: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Helpers

    private func injectType(_ type: String, into data: Data) -> Data {
        guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return data
        }
        json["type"] = type
        return (try? JSONSerialization.data(withJSONObject: json)) ?? data
    }
}
