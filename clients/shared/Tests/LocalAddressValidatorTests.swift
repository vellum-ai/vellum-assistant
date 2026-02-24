import XCTest
@testable import VellumAssistantShared

final class LocalAddressValidatorTests: XCTestCase {

    // MARK: - Positive cases (should return true)

    func testLocalhost() {
        XCTAssertTrue(LocalAddressValidator.isLocalAddress("localhost"))
    }

    func testLocalhostUppercase() {
        XCTAssertTrue(LocalAddressValidator.isLocalAddress("LOCALHOST"))
    }

    func testLocalhostMixedCase() {
        XCTAssertTrue(LocalAddressValidator.isLocalAddress("LocalHost"))
    }

    func testLoopback127_0_0_1() {
        XCTAssertTrue(LocalAddressValidator.isLocalAddress("127.0.0.1"))
    }

    func testLoopback127_255_255_255() {
        XCTAssertTrue(LocalAddressValidator.isLocalAddress("127.255.255.255"))
    }

    func testPrivate192_168_1_1() {
        XCTAssertTrue(LocalAddressValidator.isLocalAddress("192.168.1.1"))
    }

    func testPrivate10_0_0_1() {
        XCTAssertTrue(LocalAddressValidator.isLocalAddress("10.0.0.1"))
    }

    func testPrivate10_255_255_255() {
        XCTAssertTrue(LocalAddressValidator.isLocalAddress("10.255.255.255"))
    }

    func testPrivate172_16_0_1() {
        XCTAssertTrue(LocalAddressValidator.isLocalAddress("172.16.0.1"))
    }

    func testPrivate172_31_255_255() {
        XCTAssertTrue(LocalAddressValidator.isLocalAddress("172.31.255.255"))
    }

    func testIPv6Loopback() {
        XCTAssertTrue(LocalAddressValidator.isLocalAddress("::1"))
    }

    func testIPv6LinkLocal() {
        XCTAssertTrue(LocalAddressValidator.isLocalAddress("fe80::1"))
    }

    func testMDNSLocal() {
        XCTAssertTrue(LocalAddressValidator.isLocalAddress("myhost.local"))
    }

    // MARK: - Negative cases (should return false)

    func testPublicDomain() {
        XCTAssertFalse(LocalAddressValidator.isLocalAddress("google.com"))
    }

    func testPublicIP() {
        XCTAssertFalse(LocalAddressValidator.isLocalAddress("8.8.8.8"))
    }

    func testPrivate172OutOfRange_172_32() {
        XCTAssertFalse(LocalAddressValidator.isLocalAddress("172.32.0.1"))
    }

    func testPrivate172OutOfRange_172_15() {
        XCTAssertFalse(LocalAddressValidator.isLocalAddress("172.15.0.1"))
    }

    func testCraftedHostnameBypass() {
        // 10.0.0.1.evil.com has more than 4 dot-separated parts,
        // so it must NOT be treated as a private IPv4 address.
        XCTAssertFalse(LocalAddressValidator.isLocalAddress("10.0.0.1.evil.com"))
    }

    func testNonPrivate192_169() {
        XCTAssertFalse(LocalAddressValidator.isLocalAddress("192.169.1.1"))
    }

    func testNonPrivate11_0_0_1() {
        XCTAssertFalse(LocalAddressValidator.isLocalAddress("11.0.0.1"))
    }

    func testEmptyString() {
        XCTAssertFalse(LocalAddressValidator.isLocalAddress(""))
    }

    func testURLNotHost() {
        // A full URL (with scheme) is not a valid host string
        XCTAssertFalse(LocalAddressValidator.isLocalAddress("https://localhost"))
    }
}
