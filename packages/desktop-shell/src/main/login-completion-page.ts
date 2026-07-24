const checkmarkSvg = `<svg class="icon" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle class="icon-circle" cx="28" cy="28" r="28" fill="var(--accent-bg)"/>
    <path class="check" d="M17 28.5L24.5 36L39 21" stroke="var(--accent-fg)" stroke-width="3.5"
          stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;

const errorSvg = `<svg class="icon" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle class="icon-circle" cx="28" cy="28" r="28" fill="var(--accent-bg)"/>
    <path class="cross cross-1" d="M20 20L36 36" stroke="var(--accent-fg)" stroke-width="3.5" stroke-linecap="round" fill="none"/>
    <path class="cross cross-2" d="M36 20L20 36" stroke="var(--accent-fg)" stroke-width="3.5" stroke-linecap="round" fill="none"/>
  </svg>`;

export function renderLoginCompletionPage(success: boolean): string {
  const title = success ? "You're all set" : "Sign-in failed";
  const subtitle = success
    ? "You can close this tab and return to Vellum."
    : "You can close this tab and try again from Vellum.";

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vellum — ${title}</title>
<style>
:root {
  --surface: #F5F3EB;
  --surface-card: #FFFFFF;
  --card-border: #E8E6DA;
  --text-primary: #2A2A28;
  --text-secondary: #4A4A46;
  --accent-bg: ${success ? "#D4DFD0" : "#F7DAC9"};
  --accent-fg: ${success ? "#516748" : "#DA491A"};
  --accent-glow: ${success ? "rgba(81, 103, 72, 0.15)" : "rgba(218, 73, 26, 0.15)"};
  --shadow: 0 1px 2px rgba(0,0,0,0.03), 0 2px 8px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06);
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --surface: #1A1A18;
    --surface-card: #2A2A28;
    --card-border: #3A3A37;
    --text-primary: #F5F3EB;
    --text-secondary: #BDB9A9;
    --accent-bg: ${success ? "#1A2316" : "#4E281D"};
    --accent-fg: ${success ? "#7A8B6F" : "#E86B40"};
    --accent-glow: ${success ? "rgba(122, 139, 111, 0.2)" : "rgba(232, 107, 64, 0.2)"};
    --shadow: 0 1px 2px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.16), 0 8px 24px rgba(0,0,0,0.24);
  }
}
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:var(--font);
  background:var(--surface);
  color:var(--text-primary);
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:100vh;
  padding:24px;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
}
.card{
  display:flex;
  flex-direction:column;
  align-items:center;
  text-align:center;
  padding:52px 44px 44px;
  background:var(--surface-card);
  border:1px solid var(--card-border);
  border-radius:20px;
  box-shadow:var(--shadow);
  max-width:380px;
  width:100%;
  opacity:0;
  transform:translateY(12px) scale(0.96);
  animation:cardIn 0.6s cubic-bezier(0.16,1,0.3,1) 0.08s forwards;
}
@keyframes cardIn{
  to{opacity:1;transform:translateY(0) scale(1)}
}
.icon{
  width:56px;height:56px;
  margin-bottom:24px;
  flex-shrink:0;
  filter:drop-shadow(0 0 0 transparent);
  animation:iconGlow 0.6s ease-out 0.9s forwards;
  overflow:visible;
}
.icon-circle{
  transform-origin:center;
  transform:scale(0);
  animation:circlePop 0.5s cubic-bezier(0.34,1.56,0.64,1) 0.25s forwards;
}
@keyframes circlePop{
  0%{transform:scale(0)}
  100%{transform:scale(1)}
}
@keyframes iconGlow{
  to{filter:drop-shadow(0 2px 12px var(--accent-glow))}
}
.check{
  stroke-dasharray:32;
  stroke-dashoffset:32;
  animation:draw 0.45s cubic-bezier(0.65,0,0.35,1) 0.6s forwards;
}
.cross{
  stroke-dasharray:22;
  stroke-dashoffset:22;
}
.cross-1{animation:draw 0.35s cubic-bezier(0.65,0,0.35,1) 0.6s forwards}
.cross-2{animation:draw 0.35s cubic-bezier(0.65,0,0.35,1) 0.72s forwards}
@keyframes draw{
  to{stroke-dashoffset:0}
}
h1{font-size:19px;font-weight:600;letter-spacing:-0.3px;color:var(--text-primary);margin-bottom:6px;line-height:1.3}
p{font-size:14px;line-height:1.5;color:var(--text-secondary)}
</style>
</head>
<body>
<div class="card">
  ${success ? checkmarkSvg : errorSvg}
  <h1>${title}</h1>
  <p>${subtitle}</p>
</div>
</body></html>`;
}
