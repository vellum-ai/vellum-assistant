import { readAvatarState } from "../avatar/avatar-manifest.js";
import {
  renderNotificationAvatarPng,
  resolveNotificationAccentHex,
} from "../avatar/notification-avatar.js";
import { getResvg, isResvgAvailable } from "../avatar/resvg-lazy.js";

export function renderDesktopWallpaper(
  width: number,
  height: number,
  avatar: Buffer | null,
  accentHex: string | null,
): Buffer {
  const accent = /^#[\da-f]{6}$/i.test(accentHex ?? "")
    ? accentHex!
    : "#91a6b0";
  const cx = width / 2;
  const cy = height * 0.46;
  const size = Math.min(width, height) * 0.24;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <linearGradient id="base" x2="1" y2="1">
        <stop stop-color="#202a30"/><stop offset="1" stop-color="#10171c"/>
      </linearGradient>
      <radialGradient id="glow">
        <stop stop-color="${accent}" stop-opacity=".24"/>
        <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="shadow">
        <stop stop-color="#000" stop-opacity=".25"/>
        <stop offset="1" stop-color="#000" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <path fill="url(#base)" d="M0 0H${width}V${height}H0z"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${height * 0.7}" ry="${height * 0.6}" fill="url(#glow)"/>
    <g fill="none" stroke="${accent}">
      <circle cx="${cx}" cy="${cy}" r="${size * 0.76}" stroke-opacity=".16"/>
      <circle cx="${cx}" cy="${cy}" r="${size * 1.25}" stroke-opacity=".09"/>
      <circle cx="${cx}" cy="${cy}" r="${size * 1.9}" stroke-opacity=".05"/>
    </g>
    ${
      avatar
        ? `<ellipse cx="${cx}" cy="${cy + size * 0.48}" rx="${size * 0.7}" ry="${size * 0.16}" fill="url(#shadow)"/>
    <image x="${cx - size / 2}" y="${cy - size / 2}" width="${size}" height="${size}" href="data:image/png;base64,${avatar.toString("base64")}"/>`
        : ""
    }
  </svg>`;
  const Resvg = getResvg();
  return Buffer.from(new Resvg(svg).render().asPng());
}

export async function renderCurrentDesktopWallpaper(
  width: number,
  height: number,
): Promise<Buffer | null> {
  if (!isResvgAvailable()) {
    return null;
  }
  const state = readAvatarState();
  return renderDesktopWallpaper(
    width,
    height,
    await renderNotificationAvatarPng(state),
    resolveNotificationAccentHex(state),
  );
}
