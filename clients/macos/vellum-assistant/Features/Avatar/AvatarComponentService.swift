import Foundation

/// Character component type definitions used by `AvatarComponentStore`
/// for decoding the bundled `character-components.json` and providing
/// O(1) lookups by ID for body shapes, eye styles, colors, and
/// face-center overrides.
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
}
