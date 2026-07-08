import type { CSSProperties } from "react";

interface GmailLogoProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function GmailLogo({ size = 24, className, style }: GmailLogoProps) {
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
      <path
        fill="#4285F4"
        d="M6 38h6V23.4l-6-4.5z"
      />
      <path
        fill="#34A853"
        d="M36 38h6V18.9l-6 4.5z"
      />
      <path
        fill="#FBBC05"
        d="M36 12.4V23.4l6-4.5v-3.6c0-3.34-3.81-5.24-6.48-3.24z"
      />
      <path
        fill="#EA4335"
        d="M12 23.4V12.4l12 9 12-9v11l-12 9z"
      />
      <path
        fill="#C5221F"
        d="M6 15.3v3.6l6 4.5V12.4l-1.52-1.14C7.81 9.26 4 11.16 4 14.5z"
      />
    </svg>
  );
}
