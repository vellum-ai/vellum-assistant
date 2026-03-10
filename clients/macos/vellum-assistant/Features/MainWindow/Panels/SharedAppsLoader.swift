import Foundation
import VellumAssistantShared

@MainActor
enum SharedAppsLoader {
    enum LoadError: Error, Equatable {
        case timedOut
    }

    static func load(
        using daemonClient: DaemonClientProtocol,
        timeoutNanoseconds: UInt64 = 10_000_000_000
    ) async throws -> [SharedAppItem] {
        let stream = daemonClient.subscribe()
        try daemonClient.send(SharedAppsListRequestMessage())

        return try await withThrowingTaskGroup(of: [SharedAppItem].self) { group in
            group.addTask {
                for await message in stream {
                    if Task.isCancelled {
                        throw CancellationError()
                    }
                    if case .sharedAppsListResponse(let response) = message {
                        return response.apps
                    }
                }

                throw LoadError.timedOut
            }

            group.addTask {
                try await Task.sleep(nanoseconds: timeoutNanoseconds)
                throw LoadError.timedOut
            }

            defer { group.cancelAll() }
            guard let apps = try await group.next() else {
                throw LoadError.timedOut
            }
            return apps
        }
    }
}
