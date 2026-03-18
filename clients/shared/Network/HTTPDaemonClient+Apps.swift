import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Apps Domain Dispatcher (App Data Only)

/// Registers a domain dispatcher for app data requests. All other app
/// operations have been migrated to ``AppsClient`` (gateway-backed).
extension HTTPTransport {

    func registerAppsRoutes() {
        registerDomainDispatcher { [weak self] message in
            guard let self else { return false }

            if let msg = message as? AppDataRequestMessage {
                Task { await self.fetchAppData(msg) }
                return true
            }

            return false
        }
    }

    // MARK: - App Data HTTP Endpoint

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
}
