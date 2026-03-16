import Foundation
import VellumAssistantShared

@MainActor
enum AppsLoader {
    enum LoadError: Error, Equatable {
        case timedOut
        case fetchFailed
    }

    static func load(
        using daemonClient: DaemonClientProtocol,
        timeoutNanoseconds: UInt64 = 10_000_000_000
    ) async throws -> [AppItem] {
        let stream = daemonClient.subscribe()
        try daemonClient.send(AppsListRequestMessage())

        return try await withThrowingTaskGroup(of: [AppItem].self) { group in
            group.addTask {
                for await message in stream {
                    if Task.isCancelled {
                        throw CancellationError()
                    }
                    if case .appsListResponse(let response) = message {
                        guard response.success else {
                            throw LoadError.fetchFailed
                        }
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
