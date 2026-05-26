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
                    "base_price_cents": 3000,
                    "base_lookup_key": "pro_base",
                    "billing_interval": "month",
                    "machine_tiers": [
                        {
                            "tier": "medium",
                            "label": "medium",
                            "price_cents": 0,
                            "lookup_key": "pro_machine_medium",
                            "cpu_limit": "2.5",
                            "memory_gib": 5,
                            "description": "Medium machine (2.5 vCPU, 5 GiB)"
                        }
                    ],
                    "storage_tiers": [
                        {
                            "tier": "medium",
                            "label": "256 GiB",
                            "storage_gib": 256,
                            "price_cents": 0,
                            "lookup_key": "pro_storage_medium"
                        }
                    ],
                    "included_features": [
                        "Pay-as-you-go credits",
                        "Custom LLM credentials",
                        "Configurable machine size",
                        "Configurable storage",
                        "Assistant email & subdomain"
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

        // The Pro entry uses the server's tiered shape: no flat `price_cents`,
        // with pricing split across `base_price_cents` + per-tier arrays the
        // client doesn't model. Decoding must still succeed (extra keys are
        // ignored, `price_cents` decodes to nil) — a regression here is what
        // produced "Unable to load plan information." on the Plan card.
        let pro = decoded.plans[1]
        XCTAssertEqual(pro.id, "pro")
        XCTAssertEqual(pro.name, "Pro")
        XCTAssertNil(pro.price_cents)
        XCTAssertEqual(pro.billing_interval, "month")
        XCTAssertFalse(pro.included_features.isEmpty)
        XCTAssertTrue(pro.included_features.contains("Assistant email & subdomain"))
    }
}
