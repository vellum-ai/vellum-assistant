import Foundation

/// Parses LOOKS.md from the workspace and provides a color palette and outfit for the dino avatar.
public struct LooksConfig: Equatable {
    public var bodyColor: String
    public var cheekColor: String

    // Outfit
    public var hat: String
    public var hatColor: String?
    public var shirt: String
    public var shirtColor: String?
    public var accessory: String
    public var accessoryColor: String?
    public var heldItem: String

    public static let `default` = LooksConfig(
        bodyColor: "violet", cheekColor: "rose",
        hat: "none", shirt: "none", accessory: "none", heldItem: "none"
    )

    public init(
        bodyColor: String, cheekColor: String,
        hat: String, hatColor: String? = nil,
        shirt: String, shirtColor: String? = nil,
        accessory: String, accessoryColor: String? = nil,
        heldItem: String
    ) {
        self.bodyColor = bodyColor
        self.cheekColor = cheekColor
        self.hat = hat
        self.hatColor = hatColor
        self.shirt = shirt
        self.shirtColor = shirtColor
        self.accessory = accessory
        self.accessoryColor = accessoryColor
        self.heldItem = heldItem
    }

    /// Parse LOOKS.md content into a LooksConfig.
    /// Looks for lines like `- **Body:** violet`, `- **Hat:** crown (gold)`, etc.
    public static func parse(from content: String) -> LooksConfig {
        var body = "violet"
        var cheeks = "rose"
        var hat = "none"
        var hatColor: String?
        var shirt = "none"
        var shirtColor: String?
        var accessory = "none"
        var accessoryColor: String?
        var heldItem = "none"

        let range = NSRange(content.startIndex..., in: content)

        func extractValue(_ label: String) -> String? {
            let pattern = try? NSRegularExpression(
                pattern: #"-\s*\*\*"# + NSRegularExpression.escapedPattern(for: label) + #":\*\*\s*(\w+)"#,
                options: .caseInsensitive
            )
            if let match = pattern?.firstMatch(in: content, range: range),
               let valueRange = Range(match.range(at: 1), in: content) {
                return String(content[valueRange]).lowercased()
            }
            return nil
        }

        // For items that can have a color in parens: `- **Hat:** crown (gold)`
        func extractValueAndColor(_ label: String) -> (value: String, color: String?)? {
            let pattern = try? NSRegularExpression(
                pattern: #"-\s*\*\*"# + NSRegularExpression.escapedPattern(for: label) + #":\*\*\s*(\w+)(?:\s*\((\w+)\))?"#,
                options: .caseInsensitive
            )
            if let match = pattern?.firstMatch(in: content, range: range),
               let valueRange = Range(match.range(at: 1), in: content) {
                let value = String(content[valueRange]).lowercased()
                var color: String?
                if match.range(at: 2).location != NSNotFound,
                   let colorRange = Range(match.range(at: 2), in: content) {
                    color = String(content[colorRange]).lowercased()
                }
                return (value, color)
            }
            return nil
        }

        if let v = extractValue("Body") { body = v }
        if let v = extractValue("Cheeks") { cheeks = v }

        if let (v, c) = extractValueAndColor("Hat") { hat = v; hatColor = c }
        if let (v, c) = extractValueAndColor("Shirt") { shirt = v; shirtColor = c }
        if let (v, c) = extractValueAndColor("Accessory") { accessory = v; accessoryColor = c }

        // "Held Item" has a space — match with regex
        let heldItemPattern = try? NSRegularExpression(
            pattern: #"-\s*\*\*Held\s+Item:\*\*\s*(\w+)"#,
            options: .caseInsensitive
        )
        if let match = heldItemPattern?.firstMatch(in: content, range: range),
           let valueRange = Range(match.range(at: 1), in: content) {
            heldItem = String(content[valueRange]).lowercased()
        }

        return LooksConfig(
            bodyColor: body, cheekColor: cheeks,
            hat: hat, hatColor: hatColor,
            shirt: shirt, shirtColor: shirtColor,
            accessory: accessory, accessoryColor: accessoryColor,
            heldItem: heldItem
        )
    }

    /// Resolve to a DinoPalette using predefined color scales.
    /// Wing colors are derived from the body color since the 3D voxel dino has no wings.
    public func toPalette() -> DinoPalette {
        let bodyScale = BodyColorScale.scales[bodyColor] ?? BodyColorScale.scales["violet"]!
        let cheekScale = CheekColorScale.scales[cheekColor] ?? CheekColorScale.scales["rose"]!
        // Derive wing colors from body for the 2D pixel art (3D voxel has no wings)
        let wingScale = WingColorScale.scales[bodyColor] ?? WingColorScale.scales["amber"]!

        return DinoPalette(
            outline: bodyScale.outline,
            dark: bodyScale.dark,
            mid: bodyScale.mid,
            light: bodyScale.light,
            belly: bodyScale.belly,
            cheek: cheekScale.cheek,
            tongue: cheekScale.tongue,
            wingLight: wingScale.light,
            wingMid: wingScale.mid,
            wingDark: wingScale.dark
        )
    }

    /// Convert outfit fields to a DinoOutfit for the voxel generator.
    public func toOutfit() -> DinoOutfit {
        DinoOutfit(
            hat: hat, hatColor: hatColor,
            shirt: shirt, shirtColor: shirtColor,
            accessory: accessory, accessoryColor: accessoryColor,
            heldItem: heldItem
        )
    }
}
