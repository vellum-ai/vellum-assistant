import XCTest
import AppKit
@testable import VellumAssistantLib

final class PTTActivatorTests: XCTestCase {

    private let defaultsKey = "activationKey"

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: defaultsKey)
        super.tearDown()
    }

    // MARK: - Round-Trip Encoding/Decoding

    func testRoundTripModifierOnly() throws {
        let original = PTTActivator.modifierOnly(flags: .function)
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(PTTActivator.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    func testRoundTripKey() throws {
        let original = PTTActivator.key(code: 96) // F5
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(PTTActivator.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    func testRoundTripModifierKey() throws {
        let original = PTTActivator.modifierKey(code: 96, flags: .control)
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(PTTActivator.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    func testRoundTripMouseButton() throws {
        let original = PTTActivator.mouseButton(4)
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(PTTActivator.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    func testRoundTripNone() throws {
        let original = PTTActivator.off
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(PTTActivator.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    // MARK: - Legacy String Migration

    func testLegacyFn() {
        UserDefaults.standard.set("fn", forKey: defaultsKey)
        let activator = PTTActivator.fromStored()
        XCTAssertEqual(activator.kind, .modifierOnly)
        XCTAssertEqual(activator.nsModifierFlags, .function)
    }

    func testLegacyCtrl() {
        UserDefaults.standard.set("ctrl", forKey: defaultsKey)
        let activator = PTTActivator.fromStored()
        XCTAssertEqual(activator.kind, .modifierOnly)
        XCTAssertEqual(activator.nsModifierFlags, .control)
    }

    func testLegacyFnShift() {
        UserDefaults.standard.set("fn_shift", forKey: defaultsKey)
        let activator = PTTActivator.fromStored()
        XCTAssertEqual(activator.kind, .modifierOnly)
        XCTAssertEqual(activator.nsModifierFlags, [.function, .shift])
    }

    func testLegacyNone() {
        UserDefaults.standard.set("none", forKey: defaultsKey)
        let activator = PTTActivator.fromStored()
        XCTAssertEqual(activator.kind, .none)
    }

    func testNoStoredValueDefaultsToFn() {
        UserDefaults.standard.removeObject(forKey: defaultsKey)
        let activator = PTTActivator.fromStored()
        XCTAssertEqual(activator.kind, .modifierOnly)
        XCTAssertEqual(activator.nsModifierFlags, .function)
    }

    // MARK: - Malformed JSON Recovery

    func testMalformedJSONFallsBackToDefault() {
        UserDefaults.standard.set("{invalid json!!!", forKey: defaultsKey)
        let activator = PTTActivator.fromStored()
        XCTAssertEqual(activator, PTTActivator.defaultActivator)
    }

    func testInvalidFieldsFallBackToDefault() {
        // mouseButton kind with button=0 (invalid, must be >= 2)
        let json = #"{"kind":"mouseButton","mouseButton":0}"#
        UserDefaults.standard.set(json, forKey: defaultsKey)
        let activator = PTTActivator.fromStored()
        XCTAssertEqual(activator, PTTActivator.defaultActivator)
    }

    func testUnrecognizedLegacyStringFallsBackToDefault() {
        UserDefaults.standard.set("unknown_key", forKey: defaultsKey)
        let activator = PTTActivator.fromStored()
        XCTAssertEqual(activator, PTTActivator.defaultActivator)
    }

    // MARK: - Store + Retrieve JSON

    func testStoreAndRetrieveJSON() {
        let activator = PTTActivator.key(code: 96) // F5
        activator.store()
        let retrieved = PTTActivator.fromStored()
        XCTAssertEqual(retrieved, activator)
    }

    func testStoreMouseButton() {
        let activator = PTTActivator.mouseButton(3)
        activator.store()
        let retrieved = PTTActivator.fromStored()
        XCTAssertEqual(retrieved, activator)
        XCTAssertEqual(retrieved.mouseButton, 3)
    }

    // MARK: - Display Name

    func testDisplayNameFn() {
        let activator = PTTActivator.modifierOnly(flags: .function)
        XCTAssertEqual(activator.displayName, "Fn")
    }

    func testDisplayNameCtrl() {
        let activator = PTTActivator.modifierOnly(flags: .control)
        XCTAssertEqual(activator.displayName, "Ctrl")
    }

    func testDisplayNameFnShift() {
        let activator = PTTActivator.modifierOnly(flags: [.function, .shift])
        XCTAssertEqual(activator.displayName, "Fn+Shift")
    }

    func testDisplayNameKey() {
        let activator = PTTActivator.key(code: 96)
        XCTAssertEqual(activator.displayName, "F5")
    }

    func testDisplayNameModifierKey() {
        let activator = PTTActivator.modifierKey(code: 96, flags: .control)
        XCTAssertEqual(activator.displayName, "Ctrl+F5")
    }

    func testDisplayNameMouseButton() {
        let activator = PTTActivator.mouseButton(4)
        XCTAssertEqual(activator.displayName, "Mouse 4")
    }

    func testDisplayNameOff() {
        let activator = PTTActivator.off
        XCTAssertEqual(activator.displayName, "Off")
    }

    func testDisplayNameUnknownKeyCode() {
        let activator = PTTActivator.key(code: 200)
        XCTAssertEqual(activator.displayName, "Key 200")
    }

    // MARK: - Legacy String Conversion

    func testLegacyStringForPresets() {
        XCTAssertEqual(PTTActivator.modifierOnly(flags: .function).legacyString, "fn")
        XCTAssertEqual(PTTActivator.modifierOnly(flags: .control).legacyString, "ctrl")
        XCTAssertEqual(PTTActivator.modifierOnly(flags: [.function, .shift]).legacyString, "fn_shift")
        XCTAssertEqual(PTTActivator.off.legacyString, "none")
    }

    func testLegacyStringNilForCustom() {
        XCTAssertNil(PTTActivator.key(code: 96).legacyString)
        XCTAssertNil(PTTActivator.mouseButton(3).legacyString)
    }
}
