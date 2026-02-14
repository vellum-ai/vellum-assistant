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

    // Dino (violet body)
    static let dO: UInt32 = 0x5C2FB2 // dark outline
    static let dD: UInt32 = 0x7240CC // body dark
    static let dM: UInt32 = 0x8A5BE0 // body mid
    static let dL: UInt32 = 0x9878EA // body light
    static let dB: UInt32 = 0xB8A6F1 // belly highlight
    static let dW: UInt32 = 0xFFFFFF // eye white
    static let dP: UInt32 = 0x1E293B // pupil

    // Dino accents
    static let cK: UInt32 = 0xF99AAE // cheek pink (Rose._400)
    static let tR: UInt32 = 0xF06A86 // tongue (Rose._500)
    static let wA: UInt32 = 0xFDD94E // wing light (Amber._400)
    static let wB: UInt32 = 0xFAC426 // wing mid (Amber._500)
    static let wC: UInt32 = 0xE8A020 // wing dark (Amber._600)

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

    // MARK: - Dino Grid (26 wide × 22 tall) — Cute baby dragon

    static let dino: [[UInt32?]] = {
        let n: UInt32? = nil
        let O = dO, D = dD, M = dM, L = dL, B = dB, W = dW, P = dP
        let K = cK, T = tR, a = wA, b = wB, c = wC
        return [
            //  0    1    2    3    4    5    6    7    8    9   10   11   12   13   14   15   16   17   18   19   20   21   22   23   24   25
            [  n,   n,   n,   n,   n,   n,   n,   n,   n,   O,   O,   n,   n,   n,   n,   O,   O,   n,   n,   n,   n,   n,   n,   n,   n,   n], // 0  horns
            [  n,   n,   n,   n,   n,   n,   n,   n,   O,   D,   M,   O,   n,   n,   O,   M,   D,   O,   n,   n,   n,   n,   n,   n,   n,   n], // 1  horn base
            [  n,   n,   n,   n,   n,   n,   n,   O,   M,   L,   L,   L,   O,   O,   L,   L,   L,   M,   O,   n,   n,   n,   n,   n,   n,   n], // 2  head top
            [  n,   n,   n,   n,   n,   n,   O,   D,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   D,   O,   n,   n,   n,   n,   n,   n], // 3  head
            [  n,   n,   n,   n,   n,   O,   D,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   D,   O,   n,   n,   n,   n,   n], // 4  face
            [  n,   n,   n,   n,   n,   O,   D,   L,   W,   P,   P,   P,   L,   L,   P,   P,   P,   W,   L,   D,   O,   n,   n,   n,   n,   n], // 5  eyes top
            [  n,   n,   n,   n,   n,   O,   D,   L,   P,   P,   P,   P,   L,   L,   P,   P,   P,   P,   L,   D,   O,   n,   n,   n,   n,   n], // 6  eyes mid
            [  n,   n,   n,   n,   n,   O,   D,   L,   P,   P,   P,   P,   L,   L,   P,   P,   P,   P,   L,   D,   O,   n,   n,   n,   n,   n], // 7  eyes bottom
            [  n,   n,   n,   n,   n,   O,   D,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   D,   O,   n,   n,   n,   n,   n], // 8  below eyes
            [  n,   n,   n,   n,   O,   D,   M,   L,   K,   K,   L,   O,   L,   L,   O,   L,   K,   K,   L,   M,   D,   O,   n,   n,   n,   n], // 9  cheeks + mouth
            [  n,   n,   n,   n,   O,   D,   M,   L,   L,   L,   L,   L,   T,   T,   L,   L,   L,   L,   L,   M,   D,   O,   n,   n,   n,   n], // 10 tongue
            [  n,   n,   n,   n,   O,   D,   M,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   M,   D,   O,   n,   n,   n,   n], // 11 upper body
            [  n,   n,   n,   O,   D,   M,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   M,   D,   O,   n,   n,   n], // 12 body widens
            [  n,   c,   b,   O,   D,   M,   L,   L,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   L,   L,   M,   D,   O,   b,   c,   n], // 13 wings + belly
            [  c,   b,   a,   O,   D,   M,   L,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   L,   M,   D,   O,   a,   b,   c], // 14 wings peak
            [  n,   c,   b,   O,   D,   M,   L,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   L,   M,   D,   O,   b,   c,   n], // 15 wings end
            [  n,   n,   n,   O,   D,   M,   L,   L,   B,   B,   B,   B,   B,   B,   B,   B,   B,   B,   L,   L,   M,   D,   O,   n,   n,   n], // 16 body + belly
            [  n,   n,   n,   n,   O,   D,   M,   L,   L,   L,   B,   B,   B,   B,   B,   B,   L,   L,   L,   M,   D,   O,   n,   n,   n,   n], // 17 lower body
            [  n,   n,   n,   n,   n,   O,   D,   M,   L,   L,   L,   L,   L,   L,   L,   L,   L,   L,   M,   D,   O,   n,   n,   n,   n,   n], // 18 narrow
            [  n,   n,   n,   n,   n,   n,   O,   D,   M,   M,   L,   L,   L,   L,   L,   L,   M,   M,   D,   O,   n,   n,   n,   n,   n,   n], // 19 bottom
            [  n,   n,   n,   n,   n,   n,   O,   D,   D,   O,   O,   n,   n,   n,   n,   O,   O,   D,   D,   O,   n,   n,   n,   n,   n,   n], // 20 feet
            [  n,   n,   n,   n,   n,   n,   O,   O,   O,   n,   n,   n,   n,   n,   n,   n,   n,   O,   O,   O,   n,   n,   n,   n,   n,   n], // 21 feet base
        ]
    }()
}
