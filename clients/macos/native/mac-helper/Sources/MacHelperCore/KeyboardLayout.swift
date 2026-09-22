import Carbon
import Foundation

/// The letter on the keycap, for a key that is being pressed with modifiers.
///
/// A chord cannot be recognised by what the event says it types. Option+S on a
/// US layout types "ß", Option+E arms a dead key, and every layout disagrees
/// about which. What the user pressed is the key labelled S, so the key is
/// translated through their current layout with **no modifiers applied**, which
/// is the one description that matches the keycap they were looking at.
///
/// Not the keycode either: a keycode is a position on the board, and position
/// is exactly what changes between QWERTY, AZERTY and Dvorak. Translating the
/// position through the layout is what makes "S" mean S everywhere.
public enum KeyboardLayout {
    /// The character `keyCode` carries unmodified on the layout in use, or nil
    /// when the layout cannot say (no Unicode layout data, which is what a
    /// non-Unicode input source such as some IMEs reports).
    public static func unmodifiedCharacter(for keyCode: UInt16) -> String? {
        guard
            let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
            let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
        else {
            return nil
        }
        let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
        var deadKeyState: UInt32 = 0
        var length = 0
        var characters = [UniChar](repeating: 0, count: 4)
        let status = data.withUnsafeBytes { raw -> OSStatus in
            guard
                let layout = raw.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self)
            else {
                return OSStatus(paramErr)
            }
            return UCKeyTranslate(
                layout,
                keyCode,
                UInt16(kUCKeyActionDown),
                0,
                UInt32(LMGetKbdType()),
                // A dead key resolved rather than held: the caller wants the
                // key's own letter, not the accent it would compose.
                OptionBits(kUCKeyTranslateNoDeadKeysMask),
                &deadKeyState,
                characters.count,
                &length,
                &characters
            )
        }
        guard status == noErr, length > 0 else {
            return nil
        }
        return String(utf16CodeUnits: characters, count: min(length, characters.count))
    }
}
