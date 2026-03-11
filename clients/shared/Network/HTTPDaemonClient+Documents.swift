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

    // MARK: - REST Response Shapes

    /// REST shape returned by `GET /v1/documents`.
    private struct RESTDocumentListResponse: Decodable {
        let documents: [RESTDocumentListItem]
    }

    private struct RESTDocumentListItem: Decodable {
        let surfaceId: String
        let conversationId: String
        let title: String
        let wordCount: Int
        let createdAt: Int
        let updatedAt: Int
    }

    /// REST shape returned by `GET /v1/documents/:id`.
    private struct RESTDocumentLoadResponse: Decodable {
        let success: Bool
        let surfaceId: String
        let conversationId: String
        let title: String
        let content: String
        let wordCount: Int
        let createdAt: Int
        let updatedAt: Int
        let error: String?
    }

    /// REST shape returned by `POST /v1/documents`.
    private struct RESTDocumentSaveResponse: Decodable {
        let success: Bool
        let surfaceId: String
        let error: String?
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

            // REST returns { documents: [...] } without `type` — wrap into HTTP envelope
            let rest = try decoder.decode(RESTDocumentListResponse.self, from: data)
            let ipcDocs = rest.documents.map { doc in
                IPCDocumentListResponseDocument(
                    surfaceId: doc.surfaceId,
                    conversationId: doc.conversationId,
                    title: doc.title,
                    wordCount: doc.wordCount,
                    createdAt: doc.createdAt,
                    updatedAt: doc.updatedAt
                )
            }
            let ipcResponse = IPCDocumentListResponse(
                type: "document_list_response",
                documents: ipcDocs
            )
            onMessage?(.documentListResponse(ipcResponse))
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

            // REST returns { success, surfaceId, conversationId, ... } without `type` — wrap into HTTP envelope
            let rest = try decoder.decode(RESTDocumentLoadResponse.self, from: data)
            let ipcResponse = IPCDocumentLoadResponse(
                type: "document_load_response",
                surfaceId: rest.surfaceId,
                conversationId: rest.conversationId,
                title: rest.title,
                content: rest.content,
                wordCount: rest.wordCount,
                createdAt: rest.createdAt,
                updatedAt: rest.updatedAt,
                success: rest.success,
                error: rest.error
            )
            onMessage?(.documentLoadResponse(ipcResponse))
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

            // REST returns { success, surfaceId, error? } without `type` — wrap into HTTP envelope
            let rest = try decoder.decode(RESTDocumentSaveResponse.self, from: data)
            let ipcResponse = IPCDocumentSaveResponse(
                type: "document_save_response",
                surfaceId: rest.surfaceId,
                success: rest.success,
                error: rest.error
            )
            onMessage?(.documentSaveResponse(ipcResponse))
        } catch {
            log.error("Document save error: \(error.localizedDescription)")
        }
    }
}
