import type { CSSProperties } from "react";

interface GoogleCalendarLogoProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function GoogleCalendarLogo({
  size = 24,
  className,
  style,
}: GoogleCalendarLogoProps) {
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
      <path fill="#FFF" d="M37 11H11v26h26z" />
      <path fill="#1E88E5" d="M37 11h-3.5L24 18l9.5 7H37z" />
      <path fill="#FBC02D" d="M11 11v3.5L18 24l-7 9.5V37h3.5L24 30l9.5 7H37v-3.5L30 24l7-9.5V11h-3.5L24 18z" />
      <path fill="#4CAF50" d="M37 37V11l-13 9.75z" />
      <path
        fill="#1565C0"
        d="M37 41H11c-2.21 0-4-1.79-4-4V11c0-2.21 1.79-4 4-4h26c2.21 0 4 1.79 4 4v26c0 2.21-1.79 4-4 4zm-26-30v26h26V11z"
      />
      <path
        fill="#1E88E5"
        d="M21.07 25.9c-.42-.31-.71-.76-.87-1.35l1.39-.57c.09.34.24.6.46.78.21.18.47.27.78.27.31 0 .58-.1.79-.29.21-.19.32-.44.32-.73 0-.3-.11-.55-.34-.74-.22-.19-.51-.29-.85-.29h-.8v-1.38h.72c.29 0 .54-.08.74-.24.2-.16.3-.38.3-.65 0-.25-.09-.44-.27-.59-.18-.15-.41-.22-.69-.22-.27 0-.49.07-.65.22-.16.14-.28.32-.35.53l-1.38-.57c.12-.34.36-.65.71-.91.36-.27.81-.4 1.36-.4.41 0 .77.08 1.1.23.32.16.58.37.76.65.18.27.27.59.27.93 0 .35-.08.65-.25.89-.17.25-.38.44-.62.57v.08c.32.13.58.34.79.61.21.27.31.6.31.99 0 .39-.1.74-.3 1.04-.2.31-.47.55-.82.72-.35.18-.74.26-1.18.26-.51 0-.98-.15-1.43-.45zm6.27-5.07l-1.52.97-.75-1.16 2.71-1.91h1.04v8.99h-1.49v-6.89z"
      />
    </svg>
  );
}
