import Foundation
import VellumAssistantShared

@MainActor
enum AppsLoader {
    enum LoadError: Error, Equatable {
        case fetchFailed
    }

    static func load() async throws -> [AppItem] {
        let response = await AppsClient().fetchAppsList()
        guard let response, response.success else {
            throw LoadError.fetchFailed
        }
        return response.apps
    }
}
