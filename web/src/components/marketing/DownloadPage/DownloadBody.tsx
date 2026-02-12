"use client";

import Image from "next/image";
import { FullNavBar } from "@/components/marketing/CommunityPage/_FullNavBar";
import { WorkflowCTA } from "@/components/marketing/VellumHomepage/WorkflowCTA";

const DMG_URL =
  "https://github.com/alex-nork/vellum-assistant-macos-updates/releases/download/latest/vellum-assistant.dmg";

const DOWNLOAD_ICON = (
  <svg
    width="20"
    height="20"
    viewBox="0 0 20 20"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M10 2.5V12.5M10 12.5L6.25 8.75M10 12.5L13.75 8.75M3.75 15H16.25"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const APPLE_ICON = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 384 512"
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
  </svg>
);

const FEATURES = [
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
    title: "Native performance",
    description: "Built for macOS with smooth, responsive interactions.",
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    ),
    title: "Always accessible",
    description: "Launch from your menu bar, ready whenever you are.",
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
    title: "Private & secure",
    description: "Your data stays on your machine, always under your control.",
  },
];

export function DownloadBody() {
  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
@keyframes download-float {
  0%, 100% { transform: translateY(0px); }
  50% { transform: translateY(-10px); }
}
@keyframes download-fade-in {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes download-glow-pulse {
  0%, 100% { opacity: 0.5; transform: scale(1); }
  50% { opacity: 0.8; transform: scale(1.05); }
}
.download-section {
  position: relative;
  overflow: hidden;
}
.download-bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse 70% 50% at 50% 20%, rgba(104, 96, 255, 0.07) 0%, transparent 100%),
    radial-gradient(ellipse 40% 30% at 25% 60%, rgba(104, 96, 255, 0.04) 0%, transparent 100%),
    radial-gradient(ellipse 40% 30% at 75% 70%, rgba(80, 60, 200, 0.03) 0%, transparent 100%);
  pointer-events: none;
}
.download-hero {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  min-height: 100vh;
  padding: 80px 24px 60px;
  max-width: 720px;
  margin: 0 auto;
}
.download-owl-wrap {
  position: relative;
  margin-bottom: 20px;
  animation: download-float 5s ease-in-out infinite;
}
.download-owl-glow {
  position: absolute;
  inset: -40px;
  background: radial-gradient(circle, rgba(104, 96, 255, 0.35) 0%, rgba(104, 96, 255, 0.08) 40%, transparent 70%);
  border-radius: 50%;
  animation: download-glow-pulse 4s ease-in-out infinite;
  pointer-events: none;
}
.download-owl-img {
  position: relative;
  border-radius: 28px;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.4),
    0 0 0 1px rgba(255, 255, 255, 0.08);
}
.download-heading {
  font-family: "Playfair Display", serif;
  font-style: italic;
  font-weight: 400;
  font-size: 3.5rem;
  line-height: 1.15;
  color: #ffffff;
  margin: 0 0 16px;
  animation: download-fade-in 0.6s ease-out 0.1s both;
}
.download-subtext {
  font-size: 1.125rem;
  line-height: 1.6;
  color: rgba(255, 255, 255, 0.55);
  margin: 0 0 36px;
  max-width: 440px;
  animation: download-fade-in 0.6s ease-out 0.2s both;
}
.download-btn {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 16px 36px;
  background: #6860ff;
  color: #ffffff !important;
  border-radius: 12px;
  text-decoration: none !important;
  font-size: 1.05rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  transition: all 0.2s ease;
  box-shadow: 0 4px 24px rgba(104, 96, 255, 0.35);
  animation: download-fade-in 0.6s ease-out 0.3s both;
}
.download-btn:hover {
  background: #5a52e6;
  color: #ffffff !important;
  transform: translateY(-2px);
  box-shadow: 0 0 0 4px rgba(104, 96, 255, 0.15), 0 8px 32px rgba(104, 96, 255, 0.45);
}
.download-btn:active {
  transform: translateY(0);
}
.download-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 20px;
  font-size: 0.8125rem;
  color: rgba(255, 255, 255, 0.3);
  animation: download-fade-in 0.6s ease-out 0.4s both;
}
.download-divider {
  width: 48px;
  height: 1px;
  background: rgba(255, 255, 255, 0.08);
  margin: 0 auto 48px;
}
.download-features-heading {
  position: relative;
  text-align: center;
  font-size: 1.5rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.85);
  margin: 0 0 40px;
  letter-spacing: -0.01em;
}
.download-features {
  position: relative;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
  max-width: 860px;
  margin: 0 auto;
  padding: 0 24px 100px;
  animation: download-fade-in 0.6s ease-out 0.55s both;
}
.download-feature {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 36px 24px 32px;
  border-radius: 20px;
  background: linear-gradient(
    160deg,
    rgba(104, 96, 255, 0.06) 0%,
    rgba(255, 255, 255, 0.02) 50%,
    rgba(104, 96, 255, 0.03) 100%
  );
  border: 1px solid rgba(255, 255, 255, 0.06);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}
.download-feature::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(104, 96, 255, 0.3), transparent);
  opacity: 0;
  transition: opacity 0.3s ease;
}
.download-feature:hover {
  background: linear-gradient(
    160deg,
    rgba(104, 96, 255, 0.1) 0%,
    rgba(255, 255, 255, 0.04) 50%,
    rgba(104, 96, 255, 0.06) 100%
  );
  border-color: rgba(104, 96, 255, 0.2);
  transform: translateY(-4px);
  box-shadow: 0 12px 40px rgba(104, 96, 255, 0.12), 0 0 0 1px rgba(104, 96, 255, 0.1);
}
.download-feature:hover::before {
  opacity: 1;
}
.download-feature-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: linear-gradient(135deg, rgba(104, 96, 255, 0.15), rgba(104, 96, 255, 0.08));
  color: #9b95ff;
  margin-bottom: 20px;
  box-shadow: 0 2px 8px rgba(104, 96, 255, 0.1);
}
.download-feature-title {
  font-size: 1rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.92);
  margin: 0 0 8px;
  letter-spacing: -0.005em;
}
.download-feature-desc {
  font-size: 0.875rem;
  line-height: 1.6;
  color: rgba(255, 255, 255, 0.45);
  margin: 0;
}
@media (max-width: 640px) {
  .download-heading { font-size: 2.5rem; }
  .download-features { grid-template-columns: 1fr; max-width: 360px; }
  .download-hero { padding: 48px 20px 40px; }
}
`,
        }}
      />
      <FullNavBar />
      <main className="main-wrapper">
        <div className="download-section section_docs">
          <div className="download-bg" />
          <div className="download-bg-radial" />

          <div className="download-hero">
            <div className="download-owl-wrap">
              <div className="download-owl-glow" />
              <Image
                src="/velly-icon-512.png"
                alt="Vellum Assistant"
                width={128}
                height={128}
                className="download-owl-img"
                priority
              />
            </div>
            <h1 className="download-heading">
              Vellum for Mac
            </h1>
            <p className="download-subtext">
              Your personal AI assistant, running natively on macOS.
              Always a click away from your menu bar.
            </p>
            <a href={DMG_URL} className="download-btn">
              {DOWNLOAD_ICON}
              Download for macOS
            </a>
            <div className="download-meta">
              {APPLE_ICON}
              <span>Requires macOS 13 Ventura or later</span>
            </div>
          </div>

          <div className="download-divider" />

          <h2 className="download-features-heading">Why Vellum?</h2>
          <div className="download-features">
            {FEATURES.map((f) => (
              <div key={f.title} className="download-feature">
                <div className="download-feature-icon">{f.icon}</div>
                <h3 className="download-feature-title">{f.title}</h3>
                <p className="download-feature-desc">{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      </main>
      <WorkflowCTA />
    </>
  );
}
