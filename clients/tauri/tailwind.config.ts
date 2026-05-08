import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Orbitron"', "sans-serif"],
        mono: ['"Share Tech Mono"', "ui-monospace", "monospace"],
      },
      colors: {
        hud: {
          bg: "#04080d",
          panel: "rgba(7, 18, 28, 0.78)",
          panelBorder: "rgba(95, 222, 255, 0.18)",
          accent: "#5fdeff",
          accentDim: "rgba(95, 222, 255, 0.45)",
          glow: "#aef0ff",
          warn: "#ff9f55",
          danger: "#ff4d6d",
          ok: "#48ffb1",
          mute: "rgba(140, 180, 200, 0.55)",
          muted: "rgba(140, 180, 200, 0.55)",
        },
      },
      boxShadow: {
        arcReactor:
          "0 0 24px rgba(95, 222, 255, 0.55), 0 0 80px rgba(95, 222, 255, 0.25)",
        panel:
          "0 16px 80px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(95, 222, 255, 0.18)",
      },
      keyframes: {
        scanline: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
        pulseRing: {
          "0%, 100%": { transform: "scale(1)", opacity: "0.65" },
          "50%": { transform: "scale(1.08)", opacity: "1" },
        },
      },
      animation: {
        scanline: "scanline 6s linear infinite",
        pulseRing: "pulseRing 2.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
