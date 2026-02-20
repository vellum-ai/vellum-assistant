import Foundation

/// A resolved set of hex colors for the dino pixel art grid.
struct DinoPalette: Equatable {
    // Body (5 shades: outline → belly highlight)
    let outline: UInt32   // darkest
    let dark: UInt32
    let mid: UInt32
    let light: UInt32
    let belly: UInt32     // lightest

    // Eyes
    let eyeWhite: UInt32 = 0xFFFFFF
    let pupil: UInt32 = 0x1E293B

    // Accents
    let cheek: UInt32
    let tongue: UInt32    // derived from cheek (one shade darker)

    // Wings (3 shades)
    let wingLight: UInt32
    let wingMid: UInt32
    let wingDark: UInt32

    /// The default violet palette (matches current hardcoded values).
    static let violet = DinoPalette(
        outline: 0x5C2FB2, dark: 0x7240CC, mid: 0x8A5BE0,
        light: 0x9878EA, belly: 0xB8A6F1,
        cheek: 0xF99AAE, tongue: 0xF06A86,
        wingLight: 0xFDD94E, wingMid: 0xFAC426, wingDark: 0xE8A020
    )
}

// MARK: - Dino Outfit

/// Outfit choices for the 3D voxel dino. Overrides seed-derived clothing when provided.
struct DinoOutfit: Equatable {
    var hat: String         // e.g. "crown", "none"
    var hatColor: String?   // e.g. "gold" — uses item default if nil
    var shirt: String       // e.g. "hoodie", "none"
    var shirtColor: String?
    var accessory: String   // e.g. "sunglasses", "none"
    var accessoryColor: String?
    var heldItem: String    // e.g. "sword", "none"

    static let none = DinoOutfit(hat: "none", shirt: "none", accessory: "none", heldItem: "none")
}

// MARK: - Body Color Scales

/// Maps color names to 5-shade body tuples (outline, dark, mid, light, belly).
/// Hex values correspond to Tailwind-style _800, _700, _600, _500, _300 scales.
enum BodyColorScale {
    static let scales: [String: (outline: UInt32, dark: UInt32, mid: UInt32, light: UInt32, belly: UInt32)] = [
        // From ColorTokens.swift
        "violet":  (0x5C2FB2, 0x7240CC, 0x8A5BE0, 0x9878EA, 0xB8A6F1),
        "emerald": (0x0C7356, 0x10906A, 0x18B07A, 0x38CF93, 0xA6F2D1),
        "rose":    (0xA8183E, 0xD02050, 0xE84060, 0xF06A86, 0xFCBFC9),
        "amber":   (0xA35E0C, 0xC97C10, 0xE8A020, 0xFAC426, 0xFEEC94),
        "indigo":  (0x3525C4, 0x4636E8, 0x5B4EFF, 0x7B6BFF, 0xB8B4FF),
        "slate":   (0x1E293B, 0x334155, 0x475569, 0x64748B, 0xCBD5E1),
        // Additional colors (standard Tailwind hex values)
        "cyan":    (0x0E7490, 0x0891B2, 0x06B6D4, 0x22D3EE, 0x67E8F9),
        "blue":    (0x1E40AF, 0x1D4ED8, 0x2563EB, 0x3B82F6, 0x93C5FD),
        "green":   (0x166534, 0x15803D, 0x16A34A, 0x22C55E, 0x86EFAC),
        "red":     (0x991B1B, 0xB91C1C, 0xDC2626, 0xEF4444, 0xFCA5A5),
        "orange":  (0x9A3412, 0xC2410C, 0xEA580C, 0xF97316, 0xFDBA74),
        "pink":    (0x9D174D, 0xBE185D, 0xDB2777, 0xEC4899, 0xF9A8D4),
    ]
}

// MARK: - Wing Color Scales

/// Maps color names to 3-shade wing tuples (light, mid, dark).
/// Hex values correspond to _400, _500, _600 scales.
enum WingColorScale {
    static let scales: [String: (light: UInt32, mid: UInt32, dark: UInt32)] = [
        "violet":  (0xB8A6F1, 0x9878EA, 0x8A5BE0),
        "emerald": (0x6EE7B5, 0x38CF93, 0x18B07A),
        "rose":    (0xF99AAE, 0xF06A86, 0xE84060),
        "amber":   (0xFDD94E, 0xFAC426, 0xE8A020),
        "indigo":  (0x9488FF, 0x7B6BFF, 0x5B4EFF),
        "slate":   (0x94A3B8, 0x64748B, 0x475569),
        "cyan":    (0x22D3EE, 0x06B6D4, 0x0891B2),
        "blue":    (0x60A5FA, 0x3B82F6, 0x2563EB),
        "green":   (0x4ADE80, 0x22C55E, 0x16A34A),
        "red":     (0xF87171, 0xEF4444, 0xDC2626),
        "orange":  (0xFB923C, 0xF97316, 0xEA580C),
        "pink":    (0xF472B6, 0xEC4899, 0xDB2777),
    ]
}

// MARK: - Cheek Color Scales

/// Maps color names to cheek + tongue pair (cheek = _400, tongue = _500).
enum CheekColorScale {
    static let scales: [String: (cheek: UInt32, tongue: UInt32)] = [
        "violet":  (0xB8A6F1, 0x9878EA),
        "emerald": (0x6EE7B5, 0x38CF93),
        "rose":    (0xF99AAE, 0xF06A86),
        "amber":   (0xFDD94E, 0xFAC426),
        "indigo":  (0x9488FF, 0x7B6BFF),
        "slate":   (0x94A3B8, 0x64748B),
        "cyan":    (0x22D3EE, 0x06B6D4),
        "blue":    (0x60A5FA, 0x3B82F6),
        "green":   (0x4ADE80, 0x22C55E),
        "red":     (0xF87171, 0xEF4444),
        "orange":  (0xFB923C, 0xF97316),
        "pink":    (0xF472B6, 0xEC4899),
    ]
}
