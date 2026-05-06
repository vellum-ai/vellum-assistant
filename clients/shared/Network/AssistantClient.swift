import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AssistantClient")

public struct AssistantDetailResponse: Decodable, Sendable {
    public let machine_size: String?
}

public enum AssistantClient {
    public static func fetchDetail(assistantId: String) async -> AssistantDetailResponse? {
        do {
            let (decoded, response): (AssistantDetailResponse?, GatewayHTTPClient.Response) =
                try await GatewayHTTPClient.get(
                    path: "assistants/\(assistantId)/",
                    timeout: 15,
                    unprefixed: true
                ) { $0.keyDecodingStrategy = .useDefaultKeys }
            guard response.isSuccess else {
                log.error("fetchDetail failed (HTTP \(response.statusCode))")
                return nil
            }
            return decoded
        } catch {
            log.error("fetchDetail error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Two sequential vembda calls — give the platform a full minute.
    public static func proUpgradeMachine(assistantId: String) async -> (success: Bool, detail: String?) {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/\(assistantId)/pro-upgrade-machine/",
                json: [:],
                timeout: 60,
                unprefixed: true
            )
            let detail = (try? JSONSerialization.jsonObject(with: response.data) as? [String: Any])?["detail"] as? String
            if !response.isSuccess {
                log.error("proUpgradeMachine failed (HTTP \(response.statusCode))")
            }
            return (response.isSuccess, detail)
        } catch {
            log.error("proUpgradeMachine error: \(error.localizedDescription, privacy: .public)")
            return (false, nil)
        }
    }
}
