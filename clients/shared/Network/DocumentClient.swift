import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DocumentClient")

/// Focused client for document persistence operations routed through the gateway.
@MainActor
public protocol DocumentClientProtocol {
    func fetchList(conversationId: String?) async -> DocumentListResponse?
    func fetchDocument(surfaceId: String) async -> DocumentLoadResponse?
    func saveDocument(surfaceId: String, conversationId: String, title: String, content: String, wordCount: Int) async -> DocumentSaveResponse?
}

/// Gateway-backed implementation of ``DocumentClientProtocol``.
@MainActor
public struct DocumentClient: DocumentClientProtocol {
    nonisolated public init() {}

    public func fetchList(conversationId: String? = nil) async -> DocumentListResponse? {
        do {
            var params: [String: String] = [:]
            if let conversationId { params["conversationId"] = conversationId }

            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/documents",
                params: params.isEmpty ? nil : params,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchList failed (HTTP \(response.statusCode))")
                return nil
            }
            let rest = try JSONDecoder().decode(RESTDocumentListResponse.self, from: response.data)
            let docs = rest.documents.map { doc in
                DocumentListResponseDocument(
                    surfaceId: doc.surfaceId,
                    conversationId: doc.conversationId,
                    title: doc.title,
                    wordCount: doc.wordCount,
                    createdAt: doc.createdAt,
                    updatedAt: doc.updatedAt
                )
            }
            return DocumentListResponse(
                type: "document_list_response",
                documents: docs
            )
        } catch {
            log.error("fetchList error: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchDocument(surfaceId: String) async -> DocumentLoadResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/documents/\(surfaceId)", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchDocument failed (HTTP \(response.statusCode))")
                return nil
            }
            let rest = try JSONDecoder().decode(RESTDocumentLoadResponse.self, from: response.data)
            return DocumentLoadResponse(
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
        } catch {
            log.error("fetchDocument error: \(error.localizedDescription)")
            return nil
        }
    }

    public func saveDocument(surfaceId: String, conversationId: String, title: String, content: String, wordCount: Int) async -> DocumentSaveResponse? {
        do {
            let body: [String: Any] = [
                "surfaceId": surfaceId,
                "conversationId": conversationId,
                "title": title,
                "content": content,
                "wordCount": wordCount,
            ]
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/documents", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("saveDocument failed (HTTP \(response.statusCode))")
                return nil
            }
            let rest = try JSONDecoder().decode(RESTDocumentSaveResponse.self, from: response.data)
            return DocumentSaveResponse(
                type: "document_save_response",
                surfaceId: rest.surfaceId,
                success: rest.success,
                error: rest.error
            )
        } catch {
            log.error("saveDocument error: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - REST Response Shapes

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

    private struct RESTDocumentSaveResponse: Decodable {
        let success: Bool
        let surfaceId: String
        let error: String?
    }
}
