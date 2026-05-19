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
        radarSweep: {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        glitch: {
          "0%, 100%": { transform: "translate(0)", filter: "hue-rotate(0deg)" },
          "20%": { transform: "translate(-1px, 0.5px)", filter: "hue-rotate(8deg)" },
          "40%": { transform: "translate(0.5px, -0.5px)", filter: "hue-rotate(-6deg)" },
          "60%": { transform: "translate(-0.5px, 0)" },
          "80%": { transform: "translate(0.5px, 0.5px)" },
        },
        typeOn: {
          "0%": { opacity: "0", transform: "translateY(2px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        floatParticle: {
          "0%, 100%": { transform: "translate(0, 0)" },
          "50%": { transform: "translate(var(--dx, 6px), var(--dy, -8px))" },
        },
        ringFade: {
          "0%": { transform: "scale(0.5)", opacity: "0.9" },
          "100%": { transform: "scale(1.4)", opacity: "0" },
        },
        gridDrift: {
          "0%": { backgroundPosition: "0 0, 0 0" },
          "100%": { backgroundPosition: "38px 38px, 38px 38px" },
        },
        digitTicker: {
          "0%": { transform: "translateY(0)" },
          "100%": { transform: "translateY(-100%)" },
        },
        beam: {
          "0%, 100%": { opacity: "0.2", transform: "scaleX(0.6)" },
          "50%": { opacity: "1", transform: "scaleX(1)" },
        },
      },
      animation: {
        scanline: "scanline 6s linear infinite",
        pulseRing: "pulseRing 2.4s ease-in-out infinite",
        radarSweep: "radarSweep 4s linear infinite",
        glitch: "glitch 4s steps(1, end) infinite",
        typeOn: "typeOn 240ms ease-out both",
        gridDrift: "gridDrift 18s linear infinite",
        beam: "beam 3.2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
