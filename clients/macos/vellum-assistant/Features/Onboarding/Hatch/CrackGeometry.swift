import CoreGraphics

/// Static crack path definitions for 7 progressive crack sets.
/// Each set is an array of point arrays representing crack lines.
/// Coordinates are normalized to a 200×260 egg frame.
enum CrackGeometry {
    struct CrackSet {
        let paths: [[CGPoint]]
        let lineWidth: CGFloat
        let glowWidth: CGFloat
    }

    /// Set 1 (0.0→0.15): Single zigzag, top-center
    static let set1 = CrackSet(
        paths: [
            [
                CGPoint(x: 100, y: 50),
                CGPoint(x: 92, y: 68),
                CGPoint(x: 104, y: 82),
                CGPoint(x: 96, y: 98),
            ]
        ],
        lineWidth: 1.5,
        glowWidth: 2.0
    )

    /// Set 2 (0.15→0.25): Branch off set 1, downward-left
    static let set2 = CrackSet(
        paths: [
            [
                CGPoint(x: 92, y: 68),
                CGPoint(x: 78, y: 80),
                CGPoint(x: 84, y: 95),
            ]
        ],
        lineWidth: 1.5,
        glowWidth: 3.0
    )

    /// Set 3 (0.25→0.35): New crack, lower-right area
    static let set3 = CrackSet(
        paths: [
            [
                CGPoint(x: 130, y: 90),
                CGPoint(x: 138, y: 108),
                CGPoint(x: 126, y: 120),
                CGPoint(x: 134, y: 135),
            ]
        ],
        lineWidth: 2.0,
        glowWidth: 3.5
    )

    /// Set 4 (0.35→0.55): Major network across upper hemisphere
    static let set4 = CrackSet(
        paths: [
            [
                CGPoint(x: 96, y: 98),
                CGPoint(x: 110, y: 112),
                CGPoint(x: 100, y: 128),
                CGPoint(x: 116, y: 140),
            ],
            [
                CGPoint(x: 84, y: 95),
                CGPoint(x: 70, y: 110),
                CGPoint(x: 78, y: 125),
            ],
            [
                CGPoint(x: 104, y: 82),
                CGPoint(x: 120, y: 76),
                CGPoint(x: 132, y: 88),
            ],
        ],
        lineWidth: 2.0,
        glowWidth: 5.0
    )

    /// Set 5 (0.55→0.75): Large separation crack at crown
    static let set5 = CrackSet(
        paths: [
            [
                CGPoint(x: 60, y: 42),
                CGPoint(x: 80, y: 38),
                CGPoint(x: 100, y: 44),
                CGPoint(x: 120, y: 36),
                CGPoint(x: 140, y: 44),
            ],
            [
                CGPoint(x: 70, y: 110),
                CGPoint(x: 56, y: 128),
                CGPoint(x: 64, y: 145),
            ],
        ],
        lineWidth: 2.5,
        glowWidth: 6.0
    )

    /// Set 6 (0.75→0.95): Near-total coverage, creature silhouette visible
    static let set6 = CrackSet(
        paths: [
            [
                CGPoint(x: 56, y: 128),
                CGPoint(x: 44, y: 148),
                CGPoint(x: 52, y: 168),
                CGPoint(x: 40, y: 185),
            ],
            [
                CGPoint(x: 134, y: 135),
                CGPoint(x: 148, y: 155),
                CGPoint(x: 140, y: 172),
                CGPoint(x: 152, y: 188),
            ],
            [
                CGPoint(x: 100, y: 128),
                CGPoint(x: 94, y: 150),
                CGPoint(x: 106, y: 168),
                CGPoint(x: 98, y: 190),
            ],
        ],
        lineWidth: 3.0,
        glowWidth: 8.0
    )

    /// Set 7 (0.95→1.0): Full shatter
    static let set7 = CrackSet(
        paths: [
            [
                CGPoint(x: 40, y: 185),
                CGPoint(x: 60, y: 200),
                CGPoint(x: 80, y: 210),
            ],
            [
                CGPoint(x: 152, y: 188),
                CGPoint(x: 140, y: 205),
                CGPoint(x: 120, y: 210),
            ],
        ],
        lineWidth: 3.5,
        glowWidth: 10.0
    )

    /// Returns all crack sets that should be visible at a given progress.
    static func sets(for progress: CGFloat) -> [CrackSet] {
        var result: [CrackSet] = []
        if progress > 0.0 { result.append(set1) }
        if progress > 0.15 { result.append(set2) }
        if progress > 0.25 { result.append(set3) }
        if progress > 0.35 { result.append(set4) }
        if progress > 0.55 { result.append(set5) }
        if progress > 0.75 { result.append(set6) }
        if progress > 0.95 { result.append(set7) }
        return result
    }
}
