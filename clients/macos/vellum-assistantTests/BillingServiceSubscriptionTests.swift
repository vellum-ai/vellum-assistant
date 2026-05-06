import XCTest
@testable import VellumAssistantShared

/// Wire-protocol decoding tests for `SubscriptionResponse` and `PlanCatalogResponse`.
///
/// These lock in the byte-for-byte JSON shape produced by the Django serializers
/// in `vellum-assistant-platform/django/app/billing/`:
/// - `SubscriptionResponseSerializer` (`subscription_serializers.py`)
/// - `/plans/` static catalog payload (`plan_views.py`)
///
/// Any drift in field names or types on the server side will fail decoding here.
final class BillingServiceSubscriptionTests: XCTestCase {
    func testSubscriptionResponseDecodesProActiveFixture() throws {
        let json = """
        {
            "plan_id": "pro",
            "status": "active",
            "current_period_end": "2026-06-01T00:00:00Z",
            "cancel_at_period_end": false,
            "cancel_at": null
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(SubscriptionResponse.self, from: json)

        XCTAssertEqual(decoded.plan_id, "pro")
        XCTAssertEqual(decoded.status, "active")
        XCTAssertEqual(decoded.current_period_end, "2026-06-01T00:00:00Z")
        XCTAssertFalse(decoded.cancel_at_period_end)
        XCTAssertNil(decoded.cancel_at)
    }

    func testSubscriptionResponseDecodesBasePlanWithoutStripeFixture() throws {
        let json = """
        {
            "plan_id": "base",
            "status": null,
            "current_period_end": null,
            "cancel_at_period_end": false,
            "cancel_at": null
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(SubscriptionResponse.self, from: json)

        XCTAssertEqual(decoded.plan_id, "base")
        XCTAssertNil(decoded.status)
        XCTAssertNil(decoded.current_period_end)
        XCTAssertFalse(decoded.cancel_at_period_end)
        XCTAssertNil(decoded.cancel_at)
    }

    func testPlanCatalogResponseDecodesBaseAndProEntries() throws {
        let json = """
        {
            "plans": [
                {
                    "id": "base",
                    "name": "Base",
                    "price_cents": 0,
                    "billing_interval": "month",
                    "included_features": [
                        "Pay-as-you-go credits",
                        "Default machine size"
                    ]
                },
                {
                    "id": "pro",
                    "name": "Pro",
                    "price_cents": 2500,
                    "billing_interval": "month",
                    "included_features": [
                        "Larger machine size",
                        "Bundled credits",
                        "Managed email subdomain",
                        "Managed Twilio phone numbers",
                        "90-day grace period on cancellation before managed resources are released"
                    ]
                }
            ]
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(PlanCatalogResponse.self, from: json)

        XCTAssertEqual(decoded.plans.count, 2)

        let base = decoded.plans[0]
        XCTAssertEqual(base.id, "base")
        XCTAssertEqual(base.name, "Base")
        XCTAssertEqual(base.price_cents, 0)
        XCTAssertEqual(base.billing_interval, "month")
        XCTAssertFalse(base.included_features.isEmpty)
        XCTAssertEqual(base.included_features.first, "Pay-as-you-go credits")

        let pro = decoded.plans[1]
        XCTAssertEqual(pro.id, "pro")
        XCTAssertEqual(pro.name, "Pro")
        XCTAssertEqual(pro.price_cents, 2500)
        XCTAssertEqual(pro.billing_interval, "month")
        XCTAssertFalse(pro.included_features.isEmpty)
        XCTAssertTrue(pro.included_features.contains("Larger machine size"))
    }
}
