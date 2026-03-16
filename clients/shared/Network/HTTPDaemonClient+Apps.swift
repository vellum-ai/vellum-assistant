import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Apps Domain Dispatcher

extension HTTPTransport {

    func registerAppsRoutes() {
        registerDomainDispatcher { [weak self] message in
            guard let self else { return false }

            if message is AppsListRequestMessage {
                Task { await self.fetchAppsList() }
                return true
            } else if let msg = message as? AppDataRequestMessage {
                Task { await self.fetchAppData(msg) }
                return true
            } else if let msg = message as? AppOpenRequestMessage {
                Task { await self.handleAppOpen(appId: msg.appId) }
                return true
            } else if let msg = message as? AppDeleteRequestMessage {
                Task { await self.handleAppDelete(appId: msg.appId) }
                return true
            } else if let msg = message as? AppPreviewRequestMessage {
                Task { await self.fetchAppPreview(appId: msg.appId) }
                return true
            } else if let msg = message as? AppUpdatePreviewRequestMessage {
                Task { await self.handleAppUpdatePreview(appId: msg.appId, preview: msg.preview) }
                return true
            } else if let msg = message as? BundleAppRequestMessage {
                Task { await self.handleBundleApp(appId: msg.appId) }
                return true
            } else if let msg = message as? OpenBundleMessage {
                Task { await self.handleOpenBundle(filePath: msg.filePath) }
                return true
            } else if let msg = message as? AppHistoryRequest {
                Task { await self.fetchAppHistory(appId: msg.appId, limit: msg.limit) }
                return true
            } else if let msg = message as? AppDiffRequest {
                Task { await self.fetchAppDiff(appId: msg.appId, fromCommit: msg.fromCommit, toCommit: msg.toCommit) }
                return true
            } else if let msg = message as? AppRestoreRequest {
                Task { await self.handleAppRestore(appId: msg.appId, commitHash: msg.commitHash) }
                return true
            } else if message is SharedAppsListRequestMessage {
                Task { await self.fetchSharedAppsList() }
                return true
            } else if let msg = message as? SharedAppDeleteRequestMessage {
                Task { await self.handleSharedAppDelete(uuid: msg.uuid) }
                return true
            } else if let msg = message as? ForkSharedAppRequestMessage {
                Task { await self.handleForkSharedApp(uuid: msg.uuid) }
                return true
            } else if let msg = message as? ShareAppCloudRequestMessage {
                Task { await self.handleShareAppCloud(appId: msg.appId) }
                return true
            }

            return false
        }
    }

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

    // MARK: - Apps HTTP Endpoints

    private func fetchAppsList(isRetry: Bool = false) async {
        guard let url = buildURL(for: .appsList) else {
            onMessage?(.appsListResponse(AppsListResponse(
                type: "apps_list_response",
                apps: []
            )))
            return
        }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result {
                        await fetchAppsList(isRetry: true)
                    } else {
                        onMessage?(.appsListResponse(AppsListResponse(
                            type: "apps_list_response",
                            apps: []
                        )))
                    }
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("Fetch apps list failed (\(http.statusCode))")
                    onMessage?(.appsListResponse(AppsListResponse(
                        type: "apps_list_response",
                        apps: []
                    )))
                    return
                }
            }

            let decoded = try decoder.decode(HTTPAppsListResponse.self, from: data)
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
            onMessage?(.appsListResponse(AppsListResponse(
                type: "apps_list_response",
                apps: apps
            )))
        } catch {
            log.error("Fetch apps list error: \(error.localizedDescription)")
            onMessage?(.appsListResponse(AppsListResponse(
                type: "apps_list_response",
                apps: []
            )))
        }
    }

    /// REST shape returned by `/v1/apps/:id/data`.
    private struct RESTAppDataResponse: Decodable {
        let success: Bool
        let result: AnyCodable?
        let error: String?
    }

    private func fetchAppData(_ msg: AppDataRequestMessage, isRetry: Bool = false) async {
        guard let url = buildURL(for: .appData(id: msg.appId)) else { return }

        // For query methods use GET, for mutations use POST
        let isQuery = msg.method == "query" || msg.method == "get"

        var request: URLRequest
        if isQuery {
            // Build URL with query params
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            var queryItems = components?.queryItems ?? []
            queryItems.append(URLQueryItem(name: "method", value: msg.method))
            if let recordId = msg.recordId {
                queryItems.append(URLQueryItem(name: "recordId", value: recordId))
            }
            components?.queryItems = queryItems
            guard let queryURL = components?.url else { return }
            request = URLRequest(url: queryURL)
        } else {
            request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")

            var body: [String: Any] = ["method": msg.method]
            if let recordId = msg.recordId {
                body["recordId"] = recordId
            }
            if let dataDict = msg.data {
                body["data"] = jsonCompatibleDictionary(dataDict)
            }
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }

        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await fetchAppData(msg, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("App data request failed (\(http.statusCode))")
                    return
                }
            }

            // REST returns { success, result, error? } — wrap into HTTP envelope
            let rest = try decoder.decode(RESTAppDataResponse.self, from: data)
            let appDataResponse = AppDataResponse(
                type: "app_data_response",
                surfaceId: msg.surfaceId,
                callId: msg.callId,
                success: rest.success,
                result: rest.result,
                error: rest.error
            )
            onMessage?(.appDataResponse(appDataResponse))
        } catch {
            log.error("App data request error: \(error.localizedDescription)")
        }
    }

    /// REST shape returned by `/v1/apps/:id/open`.
    private struct RESTAppOpenResponse: Decodable {
        let appId: String
        let name: String
        let html: String
    }

    private func handleAppOpen(appId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .appOpen(id: appId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await handleAppOpen(appId: appId, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("App open failed (\(http.statusCode))")
                    return
                }
            }

            // REST returns { appId, name, html } — translate into ui_surface_show event
            let rest = try decoder.decode(RESTAppOpenResponse.self, from: data)
            let surfaceId = "app-\(rest.appId)"
            let surfaceMessage = UiSurfaceShowMessage(
                conversationId: nil,
                surfaceId: surfaceId,
                surfaceType: "dynamic_page",
                title: rest.name,
                data: AnyCodable(["html": rest.html, "appId": rest.appId]),
                actions: nil,
                display: "panel",
                messageId: nil
            )
            onMessage?(.uiSurfaceShow(surfaceMessage))
        } catch {
            log.error("App open error: \(error.localizedDescription)")
        }
    }

    private func handleAppDelete(appId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .appDelete(id: appId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await handleAppDelete(appId: appId, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("App delete failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(AppDeleteResponse.self, from: data)
            onMessage?(.appDeleteResponse(decoded))
        } catch {
            log.error("App delete error: \(error.localizedDescription)")
        }
    }

    private func fetchAppPreview(appId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .appPreview(id: appId)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await fetchAppPreview(appId: appId, isRetry: true) }
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("Fetch app preview failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(AppPreviewResponse.self, from: data)
            onMessage?(.appPreviewResponse(decoded))
        } catch {
            log.error("Fetch app preview error: \(error.localizedDescription)")
        }
    }

    private func handleAppUpdatePreview(appId: String, preview: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .appPreview(id: appId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = ["preview": preview]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await handleAppUpdatePreview(appId: appId, preview: preview, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("App update preview failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(AppUpdatePreviewResponse.self, from: data)
            onMessage?(.appUpdatePreviewResponse(decoded))
        } catch {
            log.error("App update preview error: \(error.localizedDescription)")
        }
    }

    private func handleBundleApp(appId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .appBundle(id: appId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await handleBundleApp(appId: appId, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("Bundle app failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(BundleAppResponse.self, from: data)
            onMessage?(.bundleAppResponse(decoded))
        } catch {
            log.error("Bundle app error: \(error.localizedDescription)")
        }
    }

    private func handleOpenBundle(filePath: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .appsOpenBundle) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = ["filePath": filePath]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await handleOpenBundle(filePath: filePath, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("Open bundle failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(OpenBundleResponse.self, from: data)
            onMessage?(.openBundleResponse(decoded))
        } catch {
            log.error("Open bundle error: \(error.localizedDescription)")
        }
    }

    private func fetchAppHistory(appId: String, limit: Double?, isRetry: Bool = false) async {
        guard let url = buildURL(for: .appHistory(id: appId)) else { return }

        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        if let limit {
            var queryItems = components?.queryItems ?? []
            queryItems.append(URLQueryItem(name: "limit", value: "\(Int(limit))"))
            components?.queryItems = queryItems
        }
        guard let finalURL = components?.url ?? url as URL? else { return }

        var request = URLRequest(url: finalURL)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await fetchAppHistory(appId: appId, limit: limit, isRetry: true) }
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("Fetch app history failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(AppHistoryResponse.self, from: data)
            onMessage?(.appHistoryResponse(decoded))
        } catch {
            log.error("Fetch app history error: \(error.localizedDescription)")
        }
    }

    private func fetchAppDiff(appId: String, fromCommit: String, toCommit: String?, isRetry: Bool = false) async {
        guard let url = buildURL(for: .appDiff(id: appId)) else { return }

        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var queryItems = components?.queryItems ?? []
        queryItems.append(URLQueryItem(name: "fromCommit", value: fromCommit))
        if let toCommit {
            queryItems.append(URLQueryItem(name: "toCommit", value: toCommit))
        }
        components?.queryItems = queryItems
        guard let finalURL = components?.url else { return }

        var request = URLRequest(url: finalURL)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await fetchAppDiff(appId: appId, fromCommit: fromCommit, toCommit: toCommit, isRetry: true) }
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("Fetch app diff failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(AppDiffResponse.self, from: data)
            onMessage?(.appDiffResponse(decoded))
        } catch {
            log.error("Fetch app diff error: \(error.localizedDescription)")
        }
    }

    private func handleAppRestore(appId: String, commitHash: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .appRestore(id: appId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = ["commitHash": commitHash]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await handleAppRestore(appId: appId, commitHash: commitHash, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("App restore failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(AppRestoreResponse.self, from: data)
            onMessage?(.appRestoreResponse(decoded))
        } catch {
            log.error("App restore error: \(error.localizedDescription)")
        }
    }

    private func fetchSharedAppsList(isRetry: Bool = false) async {
        guard let url = buildURL(for: .appsShared) else {
            onMessage?(.sharedAppsListResponse(SharedAppsListResponse(
                type: "shared_apps_list_response",
                apps: []
            )))
            return
        }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result {
                        await fetchSharedAppsList(isRetry: true)
                    } else {
                        onMessage?(.sharedAppsListResponse(SharedAppsListResponse(
                            type: "shared_apps_list_response",
                            apps: []
                        )))
                    }
                    return
                }
                if http.statusCode == 404 {
                    // Older assistants may not expose the shared-apps route yet.
                    onMessage?(.sharedAppsListResponse(SharedAppsListResponse(
                        type: "shared_apps_list_response",
                        apps: []
                    )))
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("Fetch shared apps list failed (\(http.statusCode))")
                    onMessage?(.sharedAppsListResponse(SharedAppsListResponse(
                        type: "shared_apps_list_response",
                        apps: []
                    )))
                    return
                }
            }

            let decoded = try decoder.decode(HTTPSharedAppsListResponse.self, from: data)
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
            onMessage?(.sharedAppsListResponse(SharedAppsListResponse(
                type: "shared_apps_list_response",
                apps: apps
            )))
        } catch {
            log.error("Fetch shared apps list error: \(error.localizedDescription)")
            onMessage?(.sharedAppsListResponse(SharedAppsListResponse(
                type: "shared_apps_list_response",
                apps: []
            )))
        }
    }

    private func handleSharedAppDelete(uuid: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .appsSharedDelete(uuid: uuid)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await handleSharedAppDelete(uuid: uuid, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("Shared app delete failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(SharedAppDeleteResponse.self, from: data)
            onMessage?(.sharedAppDeleteResponse(decoded))
        } catch {
            log.error("Shared app delete error: \(error.localizedDescription)")
        }
    }

    private func handleForkSharedApp(uuid: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .appsFork) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = ["uuid": uuid]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await handleForkSharedApp(uuid: uuid, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("Fork shared app failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(ForkSharedAppResponseMessage.self, from: data)
            onMessage?(.forkSharedAppResponse(decoded))
        } catch {
            log.error("Fork shared app error: \(error.localizedDescription)")
        }
    }

    private func handleShareAppCloud(appId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .appsShareCloud(id: appId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await handleShareAppCloud(appId: appId, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("Share app cloud failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(ShareAppCloudResponse.self, from: data)
            onMessage?(.shareAppCloudResponse(decoded))
        } catch {
            log.error("Share app cloud error: \(error.localizedDescription)")
        }
    }
}
