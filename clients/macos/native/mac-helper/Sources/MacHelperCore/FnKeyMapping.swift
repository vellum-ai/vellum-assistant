import Foundation

/// Where the Globe (Fn) key has been sent by the Modifier Keys table in
/// macOS Keyboard settings.
///
/// The table is stored per keyboard as an array of source/destination pairs,
/// each a HID usage packed as `page << 32 | usage`. The Globe key is the
/// source under one of two vendor pages, depending on the keyboard; a
/// destination of keyboard-page usage 0 is "No Action", and a key sent there
/// is dropped by the driver before any event tap can hear it. Pure over the
/// pairs the caller has already read, so it can be tested without a
/// preferences store.
public enum FnKeyMapping {
    /// The Globe key as a source: Apple vendor keyboard page (0xFF01) usage 3,
    /// or Apple vendor top case page (0xFF) usage 3.
    public static let globeUsages: Set<Int64> = [0xFF01_0000_0003, 0xFF00_0000_0003]

    /// Keyboard page (7) usage 0.
    public static let noActionUsage: Int64 = 0x7_0000_0000

    public static let sourceKey = "HIDKeyboardModifierMappingSrc"
    public static let destinationKey = "HIDKeyboardModifierMappingDst"

    /// What the Globe key does once the table is applied.
    public enum Destination: Equatable, Sendable {
        /// Sent to No Action: the key is dead system-wide.
        case noAction
        /// Sent to another key, named where the name is known (the modifiers
        /// the table offers) and given as its usage otherwise.
        case key(name: String?)
    }

    /// The Globe key's destination on one keyboard, or nil when the table
    /// leaves it alone. A Globe key sent to itself, which is how the table
    /// records a key put back to Globe, is left alone.
    public static func globeDestination(in pairs: [[String: Any]]) -> Destination? {
        for pair in pairs {
            guard
                let source = usage(pair[sourceKey]),
                let destination = usage(pair[destinationKey]),
                globeUsages.contains(source)
            else {
                continue
            }
            if globeUsages.contains(destination) {
                continue
            }
            if destination == noActionUsage {
                return .noAction
            }
            return .key(name: keyName(for: destination))
        }
        return nil
    }

    /// The Globe key's destination across every keyboard's table. No Action
    /// on any keyboard wins, since the key the user is pressing may be that
    /// one; otherwise the first remap found.
    public static func globeDestination(inTables tables: [[[String: Any]]]) -> Destination? {
        var found: Destination?
        for pairs in tables {
            guard let destination = globeDestination(in: pairs) else {
                continue
            }
            if destination == .noAction {
                return destination
            }
            if found == nil {
                found = destination
            }
        }
        return found
    }

    /// The keys the Modifier Keys table offers as destinations, by keyboard
    /// page usage. Anything else is reported unnamed.
    static func keyName(for destination: Int64) -> String? {
        switch destination {
        case 0x7_0000_0029: return "escape"
        case 0x7_0000_0039: return "caps lock"
        case 0x7_0000_00E0, 0x7_0000_00E4: return "control"
        case 0x7_0000_00E1, 0x7_0000_00E5: return "shift"
        case 0x7_0000_00E2, 0x7_0000_00E6: return "option"
        case 0x7_0000_00E3, 0x7_0000_00E7: return "command"
        default: return nil
        }
    }

    /// A packed usage as the plist carries it, which is a number of whatever
    /// width the writer chose.
    private static func usage(_ value: Any?) -> Int64? {
        switch value {
        case let number as Int64: return number
        case let number as Int: return Int64(number)
        case let number as NSNumber: return number.int64Value
        default: return nil
        }
    }
}
