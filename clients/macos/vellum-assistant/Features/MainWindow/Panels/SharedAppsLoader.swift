import Foundation
import VellumAssistantShared

@MainActor
enum SharedAppsLoader {

    static func load() async -> [SharedAppItem] {
        let response = await AppsClient().fetchSharedAppsList()
        return response?.apps ?? []
    }
}
