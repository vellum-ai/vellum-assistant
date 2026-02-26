import VellumAssistantShared
import Foundation

/// Static pixel-art grids for egg and dino, stored as 2D arrays of UInt32? hex colors.
/// nil = transparent pixel. Each art pixel maps to `Meadow.artPixelSize` points.
enum PixelArtData {

    // MARK: - Palette Constants

    // Egg (amber)
    static let eH: UInt32 = 0xFEEC94 // highlight
    static let eL: UInt32 = 0xFDD94E // light body
    static let eM: UInt32 = 0xFAC426 // mid body
    static let eB: UInt32 = 0xE8A020 // base body
    static let eS: UInt32 = 0xC97C10 // shadow
    static let eD: UInt32 = 0xA35E0C // deep shadow

    // MARK: - Egg Grid (28 wide × 36 tall)

    static let egg: [[UInt32?]] = {
        let n: UInt32? = nil
        let H = eH, L = eL, M = eM, B = eB, S = eS, D = eD
        return [
            //  0    1    2    3    4    5    6    7    8    9   10   11   12   13   14   15   16   17   18   19   20   21   22   23   24   25   26   27
            [  n,   n,   n,   n,   n,   n,   n,   n,   n,   n,   n,   H,   H,   H,   H,   H,   H,   n,   n,   n,   n,   n,   n,   n,   n,   n,   n,   n], // 0
            [  n,   n,   n,   n,   n,   n,   n,   n,   n,   H,   H,   H,   L,   L,   L,   L,   H,   H,   H,   n,   n,   n,   n,   n,   n,   n,   n,   n], // 1
            [  n,   n,   n,   n,   n,   n,   n,   H,   H,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   H,   H,   n,   n,   n,   n,   n,   n,   n], // 2
            [  n,   n,   n,   n,   n,   n,   H,   L,   L,   L,   L,   L,   M,   M,   M,   M,   L,   L,   L,   L,   L,   H,   n,   n,   n,   n,   n,   n], // 3
            [  n,   n,   n,   n,   n,   H,   L,   L,   L,   M,   M,   M,   M,   M,   M,   M,   M,   M,   L,   L,   L,   L,   H,   n,   n,   n,   n,   n], // 4
            [  n,   n,   n,   n,   H,   L,   L,   M,   M,   M,   M,   M,   M,   M,   M,   M,   M,   M,   M,   M,   L,   L,   L,   H,   n,   n,   n,   n], // 5
            [  n,   n,   n,   H,   L,   L,   M,   M,   M,   M,   M,   B,   B,   B,   B,   B,   B,   M,   M,   M,   M,   M,   L,   L,   H,   n,   n,   n], // 6
            [  n,   n,   n,   H,   L,   M,   M,   M,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   M,   M,   M,   M,   L,   H,   n,   n,   n], // 7
            [  n,   n,   H,   L,   M,   M,   M,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   M,   M,   M,   L,   L,   H,   n,   n], // 8
            [  n,   n,   H,   L,   M,   M,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   M,   M,   M,   L,   H,   n,   n], // 9
            [  n,   H,   L,   M,   M,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   M,   M,   L,   L,   H,   n], // 10
            [  n,   H,   L,   M,   M,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   M,   M,   L,   L,   H,   n], // 11
            [  n,   H,   L,   M,   B,   B,   B,   B,   B,   B,   S,   S,   B,   B,   B,   B,   B,   S,   S,   B,   B,   B,   B,   M,   M,   L,   H,   n], // 12
            [  H,   L,   M,   M,   B,   B,   B,   B,   B,   S,   S,   S,   B,   B,   B,   B,   S,   S,   S,   B,   B,   B,   B,   B,   M,   M,   L,   H], // 13
            [  H,   L,   M,   M,   B,   B,   B,   B,   B,   B,   S,   B,   B,   B,   B,   B,   B,   S,   B,   B,   B,   B,   B,   B,   M,   M,   L,   H], // 14
            [  H,   L,   M,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   M,   L,   H], // 15
            [  H,   L,   M,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   M,   L,   H], // 16
            [  H,   L,   M,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   M,   L,   H], // 17
            [  H,   L,   M,   B,   B,   B,   B,   B,   B,   B,   B,   S,   S,   B,   B,   S,   S,   B,   B,   B,   B,   B,   B,   B,   B,   M,   L,   H], // 18
            [  H,   L,   M,   B,   B,   B,   B,   B,   B,   B,   S,   S,   S,   S,   S,   S,   S,   S,   B,   B,   B,   B,   B,   B,   B,   M,   L,   H], // 19
            [  H,   L,   M,   M,   B,   B,   B,   B,   B,   S,   S,   D,   S,   S,   S,   S,   D,   S,   S,   B,   B,   B,   B,   B,   M,   M,   L,   H], // 20
            [  n,   H,   L,   M,   B,   B,   B,   B,   S,   S,   D,   D,   D,   S,   S,   D,   D,   D,   S,   S,   B,   B,   B,   B,   M,   L,   H,   n], // 21
            [  n,   H,   L,   M,   M,   B,   B,   S,   S,   D,   D,   D,   D,   D,   D,   D,   D,   D,   D,   S,   S,   B,   B,   M,   M,   L,   H,   n], // 22
            [  n,   H,   L,   M,   M,   B,   B,   S,   S,   D,   D,   D,   D,   D,   D,   D,   D,   D,   D,   S,   S,   B,   B,   M,   M,   L,   H,   n], // 23
            [  n,   n,   H,   L,   M,   M,   B,   B,   S,   S,   D,   D,   D,   D,   D,   D,   D,   D,   S,   S,   B,   B,   M,   M,   L,   H,   n,   n], // 24
            [  n,   n,   H,   L,   M,   M,   B,   B,   S,   S,   S,   D,   D,   D,   D,   D,   D,   S,   S,   S,   B,   B,   M,   M,   L,   H,   n,   n], // 25
            [  n,   n,   n,   H,   L,   M,   M,   B,   B,   S,   S,   S,   D,   D,   D,   D,   S,   S,   S,   B,   B,   M,   M,   L,   H,   n,   n,   n], // 26
            [  n,   n,   n,   H,   L,   M,   M,   B,   B,   S,   S,   S,   S,   D,   D,   S,   S,   S,   S,   B,   B,   M,   M,   L,   H,   n,   n,   n], // 27
            [  n,   n,   n,   n,   H,   L,   M,   M,   B,   B,   S,   S,   S,   S,   S,   S,   S,   S,   B,   B,   M,   M,   L,   H,   n,   n,   n,   n], // 28
            [  n,   n,   n,   n,   H,   L,   M,   M,   B,   B,   B,   S,   S,   S,   S,   S,   S,   B,   B,   B,   M,   M,   L,   H,   n,   n,   n,   n], // 29
            [  n,   n,   n,   n,   n,   H,   L,   M,   M,   B,   B,   B,   S,   S,   S,   S,   B,   B,   B,   M,   M,   L,   H,   n,   n,   n,   n,   n], // 30
            [  n,   n,   n,   n,   n,   n,   H,   L,   M,   M,   B,   B,   B,   S,   S,   B,   B,   B,   M,   M,   L,   H,   n,   n,   n,   n,   n,   n], // 31
            [  n,   n,   n,   n,   n,   n,   n,   H,   L,   M,   M,   B,   B,   B,   B,   B,   B,   M,   M,   L,   H,   n,   n,   n,   n,   n,   n,   n], // 32
            [  n,   n,   n,   n,   n,   n,   n,   n,   H,   L,   M,   M,   B,   B,   B,   B,   M,   M,   L,   H,   n,   n,   n,   n,   n,   n,   n,   n], // 33
            [  n,   n,   n,   n,   n,   n,   n,   n,   n,   H,   L,   M,   M,   M,   M,   M,   M,   L,   H,   n,   n,   n,   n,   n,   n,   n,   n,   n], // 34
            [  n,   n,   n,   n,   n,   n,   n,   n,   n,   n,   H,   H,   L,   L,   L,   L,   H,   H,   n,   n,   n,   n,   n,   n,   n,   n,   n,   n], // 35
        ]
    }()

}
