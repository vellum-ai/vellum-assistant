import type { CSSProperties } from "react";

interface DiscordLogoProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function DiscordLogo({ size = 24, className, style }: DiscordLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 127.14 96.36"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      style={style}
      aria-hidden
    >
      <path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2.04a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2.04a68.68 68.68 0 0 1-10.87 5.19 77.3 77.3 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53.05c0-6.94 5.04-12.67 11.45-12.67S54 46.08 53.91 53.05c0 6.95-5.07 12.64-11.46 12.64Zm42.24 0C78.41 65.69 73.25 60 73.25 53.05c0-6.94 5.04-12.67 11.44-12.67s11.51 5.73 11.44 12.67c0 6.95-5.06 12.64-11.44 12.64Z" />
    </svg>
  );
}
