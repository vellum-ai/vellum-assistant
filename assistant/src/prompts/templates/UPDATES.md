_ Lines starting with _ are comments — they won't appear in the system prompt
_
_ This file contains release update notes for the assistant.
_ Each release block is wrapped with HTML comment markers:
_ <!-- vellum-update-release:<version> -->
_ ...release notes...
_ <!-- /vellum-update-release:<version> -->
_
_ Format is freeform markdown. Write notes that help the assistant
_ understand what changed and how it affects behavior, capabilities,
_ or available tools. Focus on what matters to the user experience.

<!-- vellum-update-release:apple-containers-beta -->
## Apple Containers Install Option (macOS, Feature-Flagged)

The macOS app now supports an optional **Apple Containers** local runtime path. When enabled, Vellum runs the assistant, gateway, and credential-executor as OCI workloads inside a single Apple Virtualization framework VM, orchestrated directly by the macOS app in Swift using Apple's Containerization framework.

**Who sees this:** The Apple Containers install card appears in onboarding only when all three conditions are met: the `apple_containers_enabled` feature flag is on, the device runs macOS 15.0 or later, and the app was built with the macOS 15 SDK (so the embedded runtime module is present).

**Default state:** The feature is off by default (`apple_containers_enabled: false`). It must be explicitly enabled via the env override (`VELLUM_FLAG_APPLE_CONTAINERS_ENABLED=1`) or the Settings → Developer toggle. Do not recommend enabling this feature to users without first confirming their macOS version and hardware.

**What changes for the user:**
- A new "Apple Containers" install option appears in the onboarding runtime picker (when available).
- The hatching progress screen shows Apple Containers-specific steps: kernel prep, image pull, pod start, and gateway readiness poll.
- A `runtimeBackend: "apple-containers"` field is written to the lockfile entry. The `vellum sleep`/`wake`/`retire` CLI commands will surface a clear error for this backend type; manage the pod lifecycle through the macOS app only.
- The Settings → Developer tab includes a runtime backend picker to switch between `process` (default) and `apple-containers` modes.

**What does not change:** Inference, memory, skills, integrations, and all chat behavior are identical regardless of which local runtime backend is selected. The assistant, gateway, and CES still run as the same OCI images; only the container runtime changes.

**Diagnostic note:** If Apple Containers fails to start, check `Settings → Developer → Runtime Backend` and the diagnostics export (which now includes Apple Containers logs and state directories). The `AppleContainersAvailabilityChecker` result is captured in `apple-containers-diagnostics/apple-containers-state.json` under the `availabilityResult` key.
<!-- /vellum-update-release:apple-containers-beta -->
