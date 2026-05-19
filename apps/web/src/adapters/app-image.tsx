import { type ImgHTMLAttributes } from "react";

/**
 * Framework-agnostic Image adapter.
 *
 * Replaces Next.js `<Image>` with a plain `<img>` element.
 * All platform call sites used `unoptimized`, so no image
 * optimization was in effect. A third-party image component
 * can be wired in later if optimization is needed.
 */
export function AppImage({
  src,
  alt,
  width,
  height,
  // Next.js Image props that don't apply to plain <img>
  unoptimized: _unoptimized,
  priority: _priority,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
  alt: string;
  width?: number | string;
  height?: number | string;
  /** Ignored — kept for compatibility with call sites ported from Next.js Image. */
  unoptimized?: boolean;
  /** Ignored — kept for compatibility with call sites ported from Next.js Image. */
  priority?: boolean;
}) {
  return <img src={src} alt={alt} width={width} height={height} {...rest} />;
}
