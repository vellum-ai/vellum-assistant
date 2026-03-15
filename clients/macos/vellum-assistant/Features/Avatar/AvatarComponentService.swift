import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AvatarComponentService")

/// Fetches character component definitions from the daemon's
/// `/v1/avatar/character-components` endpoint. The response provides the
/// canonical set of body shapes, eye styles, colors, and face-center
/// overrides so the client can validate trait selections against the
/// daemon's source of truth.
@MainActor
final class AvatarComponentService {

    // MARK: - Response Model

    struct ComponentsResponse: Codable {
        let bodyShapes: [BodyShapeDef]
        let eyeStyles: [EyeStyleDef]
        let colors: [ColorDef]
        let faceCenterOverrides: [FaceCenterOverrideDef]
    }

    struct BodyShapeDef: Codable {
        let id: String
        let viewBox: SizeDef
        let faceCenter: PointDef
        let svgPath: String
    }

    struct EyeStyleDef: Codable {
        let id: String
        let sourceViewBox: SizeDef
        let eyeCenter: PointDef
        let paths: [EyePathDef]
    }

    struct EyePathDef: Codable {
        let svgPath: String
        let color: String
    }

    struct ColorDef: Codable {
        let id: String
        let hex: String
    }

    struct FaceCenterOverrideDef: Codable {
        let bodyShape: String
        let eyeStyle: String
        let faceCenter: PointDef
    }

    struct SizeDef: Codable {
        let width: Double
        let height: Double
    }

    struct PointDef: Codable {
        let x: Double
        let y: Double
    }

    // MARK: - Fetch

    /// Fetches character components from the daemon. Returns `nil` on any
    /// failure (network error, non-200 status, decode error) so callers
    /// can use safe defaults until the component store is populated.
    static func fetch(port: Int) async -> ComponentsResponse? {
        guard let url = URL(string: "http://localhost:\(port)/v1/avatar/character-components") else {
            log.warning("Invalid URL for character-components endpoint")
            return nil
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 10

        if let token = ActorTokenManager.getToken(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                log.warning("character-components fetch failed with status \(statusCode)")
                return nil
            }

            let decoded = try JSONDecoder().decode(ComponentsResponse.self, from: data)
            log.info("Fetched character components: \(decoded.bodyShapes.count) body shapes, \(decoded.eyeStyles.count) eye styles, \(decoded.colors.count) colors")
            return decoded
        } catch {
            log.warning("Failed to fetch character components: \(error.localizedDescription)")
            return nil
        }
    }
}
