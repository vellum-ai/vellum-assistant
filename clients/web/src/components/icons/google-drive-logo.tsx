import type { CSSProperties } from "react";

interface GoogleDriveLogoProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function GoogleDriveLogo({
  size = 24,
  className,
  style,
}: GoogleDriveLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden
    >
      <path fill="#FFC107" d="m17 6-11 19 5.5 9.5 11-19z" />
      <path fill="#1976D2" d="M42 31 31 12H20l11 19z" />
      <path fill="#4CAF50" d="m36.5 41.5 5.5-9.5H19l-5.5 9.5z" />
    </svg>
  );
}
