import AppKit
import Foundation

/// Singleton store that holds daemon-provided character component definitions
/// and provides O(1) lookup by ID for body shapes, eye styles, colors, and
/// face-center overrides.
@MainActor @Observable
final class AvatarComponentStore {

    static let shared = AvatarComponentStore()

    // MARK: - State

    private var components: AvatarComponentService.ComponentsResponse?

    // MARK: - Pre-indexed lookup dictionaries

    private var bodyShapeMap: [String: AvatarComponentService.BodyShapeDef] = [:]
    private var eyeStyleMap: [String: AvatarComponentService.EyeStyleDef] = [:]
    private var colorMap: [String: AvatarComponentService.ColorDef] = [:]
    private var overrideMap: [String: AvatarComponentService.PointDef] = [:]

    // MARK: - Init

    private init() {}

    // MARK: - Loading

    /// Stores the daemon response and builds pre-indexed dictionaries for O(1) lookup.
    func load(_ response: AvatarComponentService.ComponentsResponse) {
        components = response

        bodyShapeMap = Dictionary(
            response.bodyShapes.map { ($0.id, $0) },
            uniquingKeysWith: { _, latest in latest }
        )

        eyeStyleMap = Dictionary(
            response.eyeStyles.map { ($0.id, $0) },
            uniquingKeysWith: { _, latest in latest }
        )

        colorMap = Dictionary(
            response.colors.map { ($0.id, $0) },
            uniquingKeysWith: { _, latest in latest }
        )

        overrideMap = Dictionary(
            response.faceCenterOverrides.map { override in
                ("\(override.bodyShape)-\(override.eyeStyle)", override.faceCenter)
            },
            uniquingKeysWith: { _, latest in latest }
        )
    }

    // MARK: - Ready check

    /// Returns `true` once `load(_:)` has been called with a valid response.
    var isReady: Bool {
        components != nil
    }

    // MARK: - Lookups

    /// Returns the body shape definition for the given ID, or `nil` if not loaded / not found.
    func bodyShape(id: String) -> AvatarComponentService.BodyShapeDef? {
        bodyShapeMap[id]
    }

    /// Returns the eye style definition for the given ID, or `nil` if not loaded / not found.
    func eyeStyle(id: String) -> AvatarComponentService.EyeStyleDef? {
        eyeStyleMap[id]
    }

    /// Returns the color definition for the given ID, or `nil` if not loaded / not found.
    func color(id: String) -> AvatarComponentService.ColorDef? {
        colorMap[id]
    }

    /// Returns the face-center override for the given body/eye combination as a `CGPoint`,
    /// or `nil` if no override exists for that pair.
    func faceCenterOverride(bodyId: String, eyeId: String) -> CGPoint? {
        guard let point = overrideMap["\(bodyId)-\(eyeId)"] else {
            return nil
        }
        return CGPoint(x: point.x, y: point.y)
    }

    // MARK: - Hex Color Helper

    /// Parses a `#RRGGBB` hex string into an `NSColor` in the sRGB color space.
    /// Returns `.clear` for invalid input.
    static func hexToNSColor(_ hex: String) -> NSColor {
        var hexString = hex
        if hexString.hasPrefix("#") {
            hexString = String(hexString.dropFirst())
        }

        guard hexString.count == 6,
              let value = UInt64(hexString, radix: 16) else {
            return .clear
        }

        let r = CGFloat((value >> 16) & 0xFF) / 255.0
        let g = CGFloat((value >> 8) & 0xFF) / 255.0
        let b = CGFloat(value & 0xFF) / 255.0

        return NSColor(srgbRed: r, green: g, blue: b, alpha: 1)
    }
}
