import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AvatarComponentService")

/// Fetches character component definitions from the runtime's
/// `avatar/character-components` endpoint via the gateway. The response
/// provides the canonical set of body shapes, eye styles, colors, and
/// face-center overrides so the client can validate trait selections
/// against the runtime's source of truth.
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

    /// Fetches character components via the gateway. Returns `nil` on any
    /// failure (network error, non-200 status, decode error) so callers
    /// can use safe defaults until the component store is populated.
    static func fetch() async -> ComponentsResponse? {
        do {
            let (decoded, response): (ComponentsResponse?, GatewayHTTPClient.Response) =
                try await GatewayHTTPClient.get(path: "assistants/{assistantId}/avatar/character-components", timeout: 10)
            guard response.isSuccess else {
                log.warning("character-components fetch failed with status \(response.statusCode)")
                return nil
            }
            if let decoded {
                log.info("Fetched character components: \(decoded.bodyShapes.count) body shapes, \(decoded.eyeStyles.count) eye styles, \(decoded.colors.count) colors")
            }
            return decoded
        } catch {
            log.warning("Failed to fetch character components: \(error.localizedDescription)")
            return nil
        }
    }
}
