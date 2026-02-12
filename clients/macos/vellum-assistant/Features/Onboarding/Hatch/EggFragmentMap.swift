import CoreGraphics

/// Assigns each egg pixel to one of 7 shell fragments and defines their drift/burst behavior.
/// Replaces CrackGeometry.swift.
enum EggFragmentMap {

    /// Fragment indices:
    /// 0 = crown (top cap)
    /// 1 = upper-left
    /// 2 = upper-right
    /// 3 = center-left
    /// 4 = center-right
    /// 5 = lower-left
    /// 6 = lower-right

    struct FragmentDrift {
        var dx: CGFloat
        var dy: CGFloat
        var rotation: CGFloat // radians
    }

    // MARK: - Fragment Assignment Map

    /// Maps each egg pixel to a fragment index (0–6). Same dimensions as PixelArtData.egg (28×36).
    /// nil where the egg pixel is nil (transparent).
    static let fragmentMap: [[Int?]] = {
        let egg = PixelArtData.egg
        let rows = egg.count      // 36
        let cols = egg[0].count   // 28
        var map = [[Int?]](repeating: [Int?](repeating: nil, count: cols), count: rows)

        for row in 0..<rows {
            for col in 0..<cols {
                guard egg[row][col] != nil else { continue }

                // Normalized coordinates (0–1)
                let ny = CGFloat(row) / CGFloat(rows - 1)
                let nx = CGFloat(col) / CGFloat(cols - 1)
                let mid: CGFloat = 0.5

                if ny < 0.22 {
                    // Crown (top cap)
                    map[row][col] = 0
                } else if ny < 0.50 {
                    // Upper half
                    map[row][col] = nx < mid ? 1 : 2
                } else if ny < 0.72 {
                    // Center band
                    map[row][col] = nx < mid ? 3 : 4
                } else {
                    // Lower half
                    map[row][col] = nx < mid ? 5 : 6
                }
            }
        }
        return map
    }()

    // MARK: - Drift Stages

    /// 7 drift stages keyed by crack-progress thresholds.
    /// Each stage defines offsets for all 7 fragments.
    /// 7 drift stages. Top fragments break away progressively while bottom
    /// fragments stay as a "bowl" (inspired by half-shell hatching). The
    /// creature is revealed through the widening top gap.
    static let driftStages: [(threshold: CGFloat, drifts: [FragmentDrift])] = [
        // Stage 0: fully intact
        (0.00, [
            FragmentDrift(dx: 0, dy: 0, rotation: 0),       // 0 crown
            FragmentDrift(dx: 0, dy: 0, rotation: 0),       // 1 upper-left
            FragmentDrift(dx: 0, dy: 0, rotation: 0),       // 2 upper-right
            FragmentDrift(dx: 0, dy: 0, rotation: 0),       // 3 center-left
            FragmentDrift(dx: 0, dy: 0, rotation: 0),       // 4 center-right
            FragmentDrift(dx: 0, dy: 0, rotation: 0),       // 5 lower-left (bowl)
            FragmentDrift(dx: 0, dy: 0, rotation: 0),       // 6 lower-right (bowl)
        ]),
        // Stage 1 (0.15): crown lifts — first sign of life
        (0.15, [
            FragmentDrift(dx: 0, dy: 8, rotation: 0.03),
            FragmentDrift(dx: -1, dy: 0, rotation: 0),
            FragmentDrift(dx: 1, dy: 0, rotation: 0),
            FragmentDrift(dx: 0, dy: 0, rotation: 0),
            FragmentDrift(dx: 0, dy: 0, rotation: 0),
            FragmentDrift(dx: 0, dy: 0, rotation: 0),       // bowl stays
            FragmentDrift(dx: 0, dy: 0, rotation: 0),       // bowl stays
        ]),
        // Stage 2 (0.25): crown + upper-left drift apart
        (0.25, [
            FragmentDrift(dx: 2, dy: 16, rotation: 0.06),
            FragmentDrift(dx: -8, dy: 4, rotation: -0.05),
            FragmentDrift(dx: 2, dy: 1, rotation: 0.02),
            FragmentDrift(dx: 0, dy: 0, rotation: 0),
            FragmentDrift(dx: 0, dy: 0, rotation: 0),
            FragmentDrift(dx: 0, dy: 0, rotation: 0),       // bowl stays
            FragmentDrift(dx: 0, dy: 0, rotation: 0),       // bowl stays
        ]),
        // Stage 3 (0.35): upper-right joins, three top pieces away
        (0.35, [
            FragmentDrift(dx: 4, dy: 24, rotation: 0.10),
            FragmentDrift(dx: -14, dy: 10, rotation: -0.10),
            FragmentDrift(dx: 14, dy: 8, rotation: 0.08),
            FragmentDrift(dx: -3, dy: 0, rotation: -0.02),
            FragmentDrift(dx: 3, dy: 0, rotation: 0.02),
            FragmentDrift(dx: 0, dy: 0, rotation: 0),       // bowl stays
            FragmentDrift(dx: 0, dy: 0, rotation: 0),       // bowl stays
        ]),
        // Stage 4 (0.55): dramatic — center opens, top far away
        (0.55, [
            FragmentDrift(dx: 6, dy: 36, rotation: 0.15),
            FragmentDrift(dx: -24, dy: 18, rotation: -0.15),
            FragmentDrift(dx: 24, dy: 16, rotation: 0.14),
            FragmentDrift(dx: -10, dy: -2, rotation: -0.06),
            FragmentDrift(dx: 10, dy: -2, rotation: 0.06),
            FragmentDrift(dx: -2, dy: -1, rotation: -0.01),  // bowl barely moves
            FragmentDrift(dx: 2, dy: -1, rotation: 0.01),    // bowl barely moves
        ]),
        // Stage 5 (0.75): top gone, center wide, bowl holds
        (0.75, [
            FragmentDrift(dx: 8, dy: 50, rotation: 0.22),
            FragmentDrift(dx: -36, dy: 26, rotation: -0.20),
            FragmentDrift(dx: 36, dy: 24, rotation: 0.18),
            FragmentDrift(dx: -18, dy: -4, rotation: -0.12),
            FragmentDrift(dx: 18, dy: -4, rotation: 0.12),
            FragmentDrift(dx: -4, dy: -2, rotation: -0.03),  // bowl holds
            FragmentDrift(dx: 4, dy: -2, rotation: 0.03),    // bowl holds
        ]),
        // Stage 6 (0.95): everything separated, bowl slightly ajar
        (0.95, [
            FragmentDrift(dx: 10, dy: 60, rotation: 0.28),
            FragmentDrift(dx: -44, dy: 32, rotation: -0.25),
            FragmentDrift(dx: 44, dy: 30, rotation: 0.23),
            FragmentDrift(dx: -26, dy: -6, rotation: -0.18),
            FragmentDrift(dx: 26, dy: -6, rotation: 0.18),
            FragmentDrift(dx: -8, dy: -4, rotation: -0.06),  // bowl slightly open
            FragmentDrift(dx: 8, dy: -4, rotation: 0.06),    // bowl slightly open
        ]),
    ]

    /// Interpolates drift offsets for a given progress value between stages.
    static func interpolatedDrifts(for progress: CGFloat) -> [FragmentDrift] {
        let clamped = min(max(progress, 0), 0.95)

        // Find surrounding stages
        var lower = driftStages[0]
        var upper = driftStages[0]
        for i in 0..<driftStages.count {
            if driftStages[i].threshold <= clamped {
                lower = driftStages[i]
                upper = (i + 1 < driftStages.count) ? driftStages[i + 1] : driftStages[i]
            }
        }

        if lower.threshold == upper.threshold {
            return lower.drifts
        }

        let t = (clamped - lower.threshold) / (upper.threshold - lower.threshold)
        return zip(lower.drifts, upper.drifts).map { lo, hi in
            FragmentDrift(
                dx: lo.dx + (hi.dx - lo.dx) * t,
                dy: lo.dy + (hi.dy - lo.dy) * t,
                rotation: lo.rotation + (hi.rotation - lo.rotation) * t
            )
        }
    }

    // MARK: - Burst Velocities (for full hatch explosion)

    /// Per-fragment impulse vectors for the final explosion.
    static let burstVelocities: [(dx: CGFloat, dy: CGFloat, angularImpulse: CGFloat)] = [
        (  10, 280, -0.4), // crown — straight up fast
        (-200, 180, -0.6), // upper-left — up & left
        ( 210, 170,  0.5), // upper-right — up & right
        (-220,  60, -0.4), // center-left — sideways
        ( 230,  50,  0.4), // center-right — sideways
        (-180, -100, -0.5), // lower-left — bowl breaks down-left
        ( 190, -110,  0.4), // lower-right — bowl breaks down-right
    ]
}
