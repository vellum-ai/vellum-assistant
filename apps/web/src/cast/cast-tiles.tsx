import { CastProp, type PropKey } from "@/cast/cast-prop-art";

/** A tappable choice tile: chunky prop icon + one-word label, small hover lift. */
export function Tile({
  icon,
  label,
  active,
  onClick,
}: {
  icon: PropKey;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`cast-tile2${active ? " is-active" : ""}`}
      onClick={onClick}
    >
      <span className="cast-tile2__icon">
        <CastProp name={icon} className="cast-tile2__art" />
      </span>
      <span className="cast-tile2__label">{label}</span>
    </button>
  );
}

export function TileGrid({ children }: { children: React.ReactNode }) {
  return <div className="cast-tiles">{children}</div>;
}
