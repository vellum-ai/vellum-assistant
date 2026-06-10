import type { CSSProperties } from "react";

interface SlackLogoProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function SlackLogo({ size = 24, className, style }: SlackLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 124 124"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden
    >
      <path d="M26.4 78.6a10.3 10.3 0 0 1-10.3 10.3A10.3 10.3 0 0 1 5.8 78.6a10.3 10.3 0 0 1 10.3-10.3h10.3v10.3zm5.2 0a10.3 10.3 0 0 1 10.3-10.3 10.3 10.3 0 0 1 10.3 10.3v25.8a10.3 10.3 0 0 1-10.3 10.3 10.3 10.3 0 0 1-10.3-10.3V78.6z" fill="#E01E5A" />
      <path d="M41.9 26.4A10.3 10.3 0 0 1 31.6 16.1 10.3 10.3 0 0 1 41.9 5.8a10.3 10.3 0 0 1 10.3 10.3v10.3H41.9zm0 5.2a10.3 10.3 0 0 1 10.3 10.3 10.3 10.3 0 0 1-10.3 10.3H16.1A10.3 10.3 0 0 1 5.8 41.9a10.3 10.3 0 0 1 10.3-10.3h25.8z" fill="#36C5F0" />
      <path d="M93.8 41.9a10.3 10.3 0 0 1 10.3-10.3 10.3 10.3 0 0 1 10.3 10.3 10.3 10.3 0 0 1-10.3 10.3H93.8V41.9zm-5.2 0a10.3 10.3 0 0 1-10.3 10.3 10.3 10.3 0 0 1-10.3-10.3V16.1A10.3 10.3 0 0 1 78.3 5.8a10.3 10.3 0 0 1 10.3 10.3v25.8z" fill="#2EB67D" />
      <path d="M78.3 93.8a10.3 10.3 0 0 1 10.3 10.3 10.3 10.3 0 0 1-10.3 10.3 10.3 10.3 0 0 1-10.3-10.3V93.8h10.3zm0-5.2a10.3 10.3 0 0 1-10.3-10.3A10.3 10.3 0 0 1 78.3 68h25.8a10.3 10.3 0 0 1 10.3 10.3 10.3 10.3 0 0 1-10.3 10.3H78.3z" fill="#ECB22E" />
    </svg>
  );
}
