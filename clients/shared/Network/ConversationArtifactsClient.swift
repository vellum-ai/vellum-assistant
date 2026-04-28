import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ConversationArtifactsClient")

/// Client for fetching all artifacts (apps and documents) associated with a conversation.
public protocol ConversationArtifactsClientProtocol {
    func fetchArtifacts(conversationId: String) async -> [ConversationArtifact]
}

/// Concrete implementation that fetches apps and documents concurrently and merges them
/// into a unified, sorted list of ``ConversationArtifact`` values.
public struct ConversationArtifactsClient: ConversationArtifactsClientProtocol {
    private let appsClient: AppsClientProtocol
    private let documentClient: DocumentClientProtocol

    public init(
        appsClient: AppsClientProtocol = AppsClient(),
        documentClient: DocumentClientProtocol = DocumentClient()
    ) {
        self.appsClient = appsClient
        self.documentClient = documentClient
    }

    public func fetchArtifacts(conversationId: String) async -> [ConversationArtifact] {
        async let appsResponse = appsClient.fetchAppsList(conversationId: conversationId)
        async let docsResponse = documentClient.fetchList(conversationId: conversationId)
        let (apps, docs) = await (appsResponse, docsResponse)

        var artifacts: [ConversationArtifact] = []

        if let apps {
            let appArtifacts = apps.apps.map { app in
                ConversationArtifact(
                    id: app.id,
                    type: .app,
                    title: app.name,
                    appId: app.id,
                    surfaceId: nil
                )
            }
            artifacts.append(contentsOf: appArtifacts)
        } else {
            log.warning("fetchArtifacts: apps fetch failed for conversationId=\(conversationId)")
        }

        if let docs {
            let docArtifacts = docs.documents.map { doc in
                ConversationArtifact(
                    id: doc.surfaceId,
                    type: .document,
                    title: doc.title,
                    appId: nil,
                    surfaceId: doc.surfaceId
                )
            }
            artifacts.append(contentsOf: docArtifacts)
        } else {
            log.warning("fetchArtifacts: documents fetch failed for conversationId=\(conversationId)")
        }

        // Sort: apps first, then documents; each group alphabetical by title
        artifacts.sort { lhs, rhs in
            if lhs.type != rhs.type {
                return lhs.type == .app
            }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }

        return artifacts
    }
}
