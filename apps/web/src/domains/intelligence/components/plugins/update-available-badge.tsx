/**
 * Small pill flagging that an installed plugin is behind the marketplace
 * pin. Shared by the plugins list row and the plugin detail header so the
 * "update available" affordance reads identically on both surfaces.
 */
export function UpdateAvailableBadge() {
  return (
    <span
      className="shrink-0 rounded px-1.5 py-0.5 text-body-small-default"
      style={{
        backgroundColor: "var(--surface-info, var(--surface-secondary))",
        color: "var(--content-info, var(--primary-base, #60a5fa))",
      }}
    >
      Update available
    </span>
  );
}
