import XCTest
@testable import VellumAssistantShared

final class VersionCompatTests: XCTestCase {

    // MARK: - parse() basic cases

    func testParseSimpleVersion() {
        let v = VersionCompat.parse("1.2.3")
        XCTAssertEqual(v, ParsedVersion(major: 1, minor: 2, patch: 3, pre: nil))
    }

    func testParseVersionWithVPrefix() {
        let v = VersionCompat.parse("v1.2.3")
        XCTAssertEqual(v, ParsedVersion(major: 1, minor: 2, patch: 3, pre: nil))
    }

    func testParseVersionWithUppercaseVPrefix() {
        let v = VersionCompat.parse("V1.2.3")
        XCTAssertEqual(v, ParsedVersion(major: 1, minor: 2, patch: 3, pre: nil))
    }

    func testParseTwoComponentVersion() {
        let v = VersionCompat.parse("1.2")
        XCTAssertEqual(v, ParsedVersion(major: 1, minor: 2, patch: 0, pre: nil))
    }

    func testParseReturnsNilForEmptyString() {
        XCTAssertNil(VersionCompat.parse(""))
    }

    func testParseReturnsNilForBareV() {
        XCTAssertNil(VersionCompat.parse("v"))
    }

    func testParseReturnsNilForGarbage() {
        XCTAssertNil(VersionCompat.parse("not-a-version"))
    }

    func testParseReturnsNilForSingleNumber() {
        XCTAssertNil(VersionCompat.parse("42"))
    }

    // MARK: - parse() pre-release

    func testParsePreReleaseSuffix() {
        let v = VersionCompat.parse("1.2.3-staging.5")
        XCTAssertEqual(v, ParsedVersion(major: 1, minor: 2, patch: 3, pre: "staging.5"))
    }

    func testParsePreReleaseWithVPrefix() {
        let v = VersionCompat.parse("v0.6.0-staging.1")
        XCTAssertEqual(v, ParsedVersion(major: 0, minor: 6, patch: 0, pre: "staging.1"))
    }

    func testParsePreReleaseMultipleHyphens() {
        let v = VersionCompat.parse("1.0.0-alpha-beta.1")
        XCTAssertEqual(v, ParsedVersion(major: 1, minor: 0, patch: 0, pre: "alpha-beta.1"))
    }

    func testParseBuildMetadataStripped() {
        let v = VersionCompat.parse("1.2.3+build.123")
        XCTAssertEqual(v, ParsedVersion(major: 1, minor: 2, patch: 3, pre: nil))
    }

    func testParsePreReleaseWithBuildMetadata() {
        let v = VersionCompat.parse("1.2.3-beta.1+build.456")
        XCTAssertEqual(v, ParsedVersion(major: 1, minor: 2, patch: 3, pre: "beta.1"))
    }

    // MARK: - Comparable (< operator) basic ordering

    func testLessThanByMajor() {
        let a = ParsedVersion(major: 1, minor: 0, patch: 0, pre: nil)
        let b = ParsedVersion(major: 2, minor: 0, patch: 0, pre: nil)
        XCTAssertTrue(a < b)
        XCTAssertFalse(b < a)
    }

    func testLessThanByMinor() {
        let a = ParsedVersion(major: 1, minor: 2, patch: 0, pre: nil)
        let b = ParsedVersion(major: 1, minor: 3, patch: 0, pre: nil)
        XCTAssertTrue(a < b)
        XCTAssertFalse(b < a)
    }

    func testLessThanByPatch() {
        let a = ParsedVersion(major: 1, minor: 2, patch: 3, pre: nil)
        let b = ParsedVersion(major: 1, minor: 2, patch: 4, pre: nil)
        XCTAssertTrue(a < b)
        XCTAssertFalse(b < a)
    }

    func testEqualVersionsNotLessThan() {
        let a = ParsedVersion(major: 1, minor: 2, patch: 3, pre: nil)
        let b = ParsedVersion(major: 1, minor: 2, patch: 3, pre: nil)
        XCTAssertFalse(a < b)
        XCTAssertFalse(b < a)
    }

    // MARK: - Comparable: pre-release vs release (semver §11)

    func testPreReleaseLessThanRelease() {
        let pre = ParsedVersion(major: 1, minor: 2, patch: 3, pre: "staging.5")
        let rel = ParsedVersion(major: 1, minor: 2, patch: 3, pre: nil)
        XCTAssertTrue(pre < rel)
        XCTAssertFalse(rel < pre)
    }

    func testStagingVersionLessThanRelease() {
        let staging = VersionCompat.parse("0.6.0-staging.5")!
        let release = VersionCompat.parse("0.6.0")!
        XCTAssertTrue(staging < release)
    }

    func testBothNilPreReleaseEqual() {
        let a = ParsedVersion(major: 1, minor: 0, patch: 0, pre: nil)
        let b = ParsedVersion(major: 1, minor: 0, patch: 0, pre: nil)
        XCTAssertFalse(a < b)
        XCTAssertFalse(b < a)
    }

    // MARK: - Comparable: pre-release numeric ordering

    func testPreReleaseNumericOrdering() {
        let a = ParsedVersion(major: 1, minor: 0, patch: 0, pre: "staging.1")
        let b = ParsedVersion(major: 1, minor: 0, patch: 0, pre: "staging.2")
        XCTAssertTrue(a < b)
        XCTAssertFalse(b < a)
    }

    func testPreReleaseNumericNotLexical() {
        // "9" < "10" numerically, but "9" > "10" lexically
        let a = ParsedVersion(major: 1, minor: 0, patch: 0, pre: "staging.9")
        let b = ParsedVersion(major: 1, minor: 0, patch: 0, pre: "staging.10")
        XCTAssertTrue(a < b)
        XCTAssertFalse(b < a)
    }

    func testPreReleaseEqualIdentifiers() {
        let a = ParsedVersion(major: 1, minor: 0, patch: 0, pre: "staging.5")
        let b = ParsedVersion(major: 1, minor: 0, patch: 0, pre: "staging.5")
        XCTAssertFalse(a < b)
        XCTAssertFalse(b < a)
    }

    // MARK: - Comparable: pre-release lexical ordering

    func testPreReleaseLexicalOrdering() {
        let a = ParsedVersion(major: 1, minor: 0, patch: 0, pre: "alpha")
        let b = ParsedVersion(major: 1, minor: 0, patch: 0, pre: "beta")
        XCTAssertTrue(a < b)
        XCTAssertFalse(b < a)
    }

    // MARK: - Comparable: numeric vs non-numeric (semver §11.4.4)

    func testNumericSortsLowerThanNonNumeric() {
        let a = ParsedVersion(major: 1, minor: 0, patch: 0, pre: "1")
        let b = ParsedVersion(major: 1, minor: 0, patch: 0, pre: "alpha")
        XCTAssertTrue(a < b)
        XCTAssertFalse(b < a)
    }

    // MARK: - Comparable: fewer identifiers sort earlier

    func testFewerIdentifiersSortEarlier() {
        let a = ParsedVersion(major: 1, minor: 0, patch: 0, pre: "alpha")
        let b = ParsedVersion(major: 1, minor: 0, patch: 0, pre: "alpha.1")
        XCTAssertTrue(a < b)
        XCTAssertFalse(b < a)
    }

    // MARK: - Comparable: derived operators

    func testGreaterThan() {
        let a = ParsedVersion(major: 2, minor: 0, patch: 0, pre: nil)
        let b = ParsedVersion(major: 1, minor: 0, patch: 0, pre: nil)
        XCTAssertTrue(a > b)
    }

    func testGreaterThanOrEqual() {
        let a = ParsedVersion(major: 1, minor: 0, patch: 0, pre: nil)
        let b = ParsedVersion(major: 1, minor: 0, patch: 0, pre: nil)
        XCTAssertTrue(a >= b)
    }

    func testLessThanOrEqual() {
        let a = ParsedVersion(major: 1, minor: 0, patch: 0, pre: "staging.1")
        let b = ParsedVersion(major: 1, minor: 0, patch: 0, pre: nil)
        XCTAssertTrue(a <= b)
    }

    func testNotEqual() {
        let a = ParsedVersion(major: 1, minor: 0, patch: 0, pre: "staging.1")
        let b = ParsedVersion(major: 1, minor: 0, patch: 0, pre: nil)
        XCTAssertTrue(a != b)
    }

    // MARK: - coreEquals

    func testCoreEqualsSameVersion() {
        let a = ParsedVersion(major: 1, minor: 2, patch: 3, pre: nil)
        let b = ParsedVersion(major: 1, minor: 2, patch: 3, pre: nil)
        XCTAssertTrue(a.coreEquals(b))
    }

    func testCoreEqualsIgnoresPreRelease() {
        let a = ParsedVersion(major: 1, minor: 2, patch: 3, pre: "staging.5")
        let b = ParsedVersion(major: 1, minor: 2, patch: 3, pre: nil)
        XCTAssertTrue(a.coreEquals(b))
    }

    func testCoreEqualsDifferentPreReleases() {
        let a = ParsedVersion(major: 1, minor: 2, patch: 3, pre: "staging.1")
        let b = ParsedVersion(major: 1, minor: 2, patch: 3, pre: "staging.2")
        XCTAssertTrue(a.coreEquals(b))
    }

    func testCoreEqualsReturnsFalseForDifferentPatch() {
        let a = ParsedVersion(major: 1, minor: 2, patch: 3, pre: nil)
        let b = ParsedVersion(major: 1, minor: 2, patch: 4, pre: nil)
        XCTAssertFalse(a.coreEquals(b))
    }

    // MARK: - Equatable (includes pre-release)

    func testEquatableIncludesPreRelease() {
        let a = ParsedVersion(major: 1, minor: 2, patch: 3, pre: "staging.5")
        let b = ParsedVersion(major: 1, minor: 2, patch: 3, pre: nil)
        XCTAssertNotEqual(a, b)
    }

    func testEquatableSamePreRelease() {
        let a = ParsedVersion(major: 1, minor: 2, patch: 3, pre: "staging.5")
        let b = ParsedVersion(major: 1, minor: 2, patch: 3, pre: "staging.5")
        XCTAssertEqual(a, b)
    }

    // MARK: - isCompatible

    func testIsCompatibleSameMajorMinor() {
        XCTAssertTrue(VersionCompat.isCompatible(clientVersion: "1.2.0", serviceGroupVersion: "1.2.5"))
    }

    func testIsCompatibleDifferentMinor() {
        XCTAssertFalse(VersionCompat.isCompatible(clientVersion: "1.2.0", serviceGroupVersion: "1.3.0"))
    }

    func testIsCompatibleWithPreRelease() {
        XCTAssertTrue(VersionCompat.isCompatible(clientVersion: "0.6.0-staging.5", serviceGroupVersion: "0.6.0"))
    }

    // MARK: - parseMajorMinor

    func testParseMajorMinor() {
        let result = VersionCompat.parseMajorMinor("v1.2.3-staging.1")
        XCTAssertEqual(result?.major, 1)
        XCTAssertEqual(result?.minor, 2)
    }

    func testParseMajorMinorInvalid() {
        XCTAssertNil(VersionCompat.parseMajorMinor("garbage"))
    }
}
