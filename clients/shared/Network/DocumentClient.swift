import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "DocumentClient")

/// Focused client for document persistence operations routed through the gateway.
public protocol DocumentClientProtocol {
    func fetchList(conversationId: String?) async -> DocumentListResponse?
    func fetchDocument(surfaceId: String) async -> DocumentLoadResponse?
    func saveDocument(surfaceId: String, conversationId: String, title: String, content: String, wordCount: Int) async -> DocumentSaveResponse?
    func exportDocumentPDF(surfaceId: String) async -> Data?

    // MARK: - Comments

    func fetchComments(surfaceId: String, status: String?) async -> [DocumentComment]?
    func createComment(surfaceId: String, content: String, conversationId: String, anchorStart: Int?, anchorEnd: Int?, anchorText: String?, parentCommentId: String?) async -> DocumentComment?
    func resolveComment(surfaceId: String, commentId: String) async -> DocumentComment?
    func deleteComment(surfaceId: String, commentId: String) async -> Bool
}

/// Gateway-backed implementation of ``DocumentClientProtocol``.
public struct DocumentClient: DocumentClientProtocol {
    nonisolated public init() {}

    public func fetchList(conversationId: String? = nil) async -> DocumentListResponse? {
        do {
            var params: [String: String] = [:]
            if let conversationId { params["conversationId"] = conversationId }

            let response = try await GatewayHTTPClient.get(
                path: "documents",
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
                path: "documents/\(surfaceId)", timeout: 10
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
                path: "documents", json: body, timeout: 10
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

    public func exportDocumentPDF(surfaceId: String) async -> Data? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/documents/\(surfaceId)/pdf",
                timeout: 30
            )
            guard response.isSuccess else {
                log.error("exportDocumentPDF failed (HTTP \(response.statusCode))")
                return nil
            }
            return response.data
        } catch {
            log.error("exportDocumentPDF error: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Comments

    public func fetchComments(surfaceId: String, status: String? = nil) async -> [DocumentComment]? {
        do {
            var params: [String: String] = [:]
            if let status { params["status"] = status }

            let response = try await GatewayHTTPClient.get(
                path: "documents/\(surfaceId)/comments",
                params: params.isEmpty ? nil : params,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchComments failed (HTTP \(response.statusCode))")
                return nil
            }
            let rest = try JSONDecoder().decode(RESTCommentListResponse.self, from: response.data)
            return rest.comments
        } catch {
            log.error("fetchComments error: \(error.localizedDescription)")
            return nil
        }
    }

    public func createComment(surfaceId: String, content: String, conversationId: String, anchorStart: Int? = nil, anchorEnd: Int? = nil, anchorText: String? = nil, parentCommentId: String? = nil) async -> DocumentComment? {
        do {
            var body: [String: Any] = [
                "content": content,
                "conversationId": conversationId,
            ]
            if let anchorStart { body["anchorStart"] = anchorStart }
            if let anchorEnd { body["anchorEnd"] = anchorEnd }
            if let anchorText { body["anchorText"] = anchorText }
            if let parentCommentId { body["parentCommentId"] = parentCommentId }

            let response = try await GatewayHTTPClient.post(
                path: "documents/\(surfaceId)/comments",
                json: body,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("createComment failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(DocumentComment.self, from: response.data)
        } catch {
            log.error("createComment error: \(error.localizedDescription)")
            return nil
        }
    }

    public func resolveComment(surfaceId: String, commentId: String) async -> DocumentComment? {
        do {
            let response = try await GatewayHTTPClient.patch(
                path: "documents/\(surfaceId)/comments/\(commentId)",
                json: ["status": "resolved"],
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("resolveComment failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(DocumentComment.self, from: response.data)
        } catch {
            log.error("resolveComment error: \(error.localizedDescription)")
            return nil
        }
    }

    public func deleteComment(surfaceId: String, commentId: String) async -> Bool {
        do {
            let response = try await GatewayHTTPClient.delete(
                path: "documents/\(surfaceId)/comments/\(commentId)",
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("deleteComment failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("deleteComment error: \(error.localizedDescription)")
            return false
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

    private struct RESTCommentListResponse: Decodable {
        let comments: [DocumentComment]
    }
}
