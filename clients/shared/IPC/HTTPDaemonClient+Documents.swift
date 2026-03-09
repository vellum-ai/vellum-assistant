import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Documents Domain Dispatcher

extension HTTPTransport {

    func registerDocumentsRoutes() {
        registerDomainDispatcher { [weak self] message in
            guard let self else { return false }

            if let msg = message as? DocumentListRequestMessage {
                Task { await self.fetchDocumentList(conversationId: msg.conversationId) }
                return true
            } else if let msg = message as? DocumentLoadRequestMessage {
                Task { await self.fetchDocumentLoad(surfaceId: msg.surfaceId) }
                return true
            } else if let msg = message as? DocumentSaveRequestMessage {
                Task {
                    await self.handleDocumentSave(
                        surfaceId: msg.surfaceId,
                        conversationId: msg.conversationId,
                        title: msg.title,
                        content: msg.content,
                        wordCount: msg.wordCount
                    )
                }
                return true
            }

            return false
        }
    }

    // MARK: - Documents HTTP Endpoints

    private func fetchDocumentList(conversationId: String?, isRetry: Bool = false) async {
        guard let url = buildURL(for: .documentsList) else { return }

        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        if let conversationId {
            var queryItems = components?.queryItems ?? []
            queryItems.append(URLQueryItem(name: "conversationId", value: conversationId))
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
                    if case .success = result { await fetchDocumentList(conversationId: conversationId, isRetry: true) }
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("Fetch document list failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(IPCDocumentListResponse.self, from: data)
            onMessage?(.documentListResponse(decoded))
        } catch {
            log.error("Fetch document list error: \(error.localizedDescription)")
        }
    }

    private func fetchDocumentLoad(surfaceId: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .documentLoad(id: surfaceId)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await fetchDocumentLoad(surfaceId: surfaceId, isRetry: true) }
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("Fetch document load failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(IPCDocumentLoadResponse.self, from: data)
            onMessage?(.documentLoadResponse(decoded))
        } catch {
            log.error("Fetch document load error: \(error.localizedDescription)")
        }
    }

    private func handleDocumentSave(
        surfaceId: String,
        conversationId: String,
        title: String,
        content: String,
        wordCount: Int,
        isRetry: Bool = false
    ) async {
        guard let url = buildURL(for: .documentSave) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = [
            "surfaceId": surfaceId,
            "conversationId": conversationId,
            "title": title,
            "content": content,
            "wordCount": wordCount,
        ]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result {
                        await handleDocumentSave(
                            surfaceId: surfaceId,
                            conversationId: conversationId,
                            title: title,
                            content: content,
                            wordCount: wordCount,
                            isRetry: true
                        )
                    }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("Document save failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(IPCDocumentSaveResponse.self, from: data)
            onMessage?(.documentSaveResponse(decoded))
        } catch {
            log.error("Document save error: \(error.localizedDescription)")
        }
    }
}
