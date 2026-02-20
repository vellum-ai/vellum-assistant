// This file is auto-generated from index.html.
// It exists because bun build --compile cannot embed files read via
// readFileSync at runtime. By exporting the HTML as a string constant,
// the bundler includes it in the compiled binary.
//
// To regenerate: copy the contents of index.html into the template literal below.

export const PREBUILT_HOME_BASE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Home Base</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800;1,9..40,400&family=DM+Mono:wght@400;500&display=swap');

    :root {
      --v-slate-950: #070D19;
      --v-slate-900: #0F172A;
      --v-slate-800: #1E293B;
      --v-slate-700: #334155;
      --v-slate-600: #475569;
      --v-slate-500: #64748B;
      --v-slate-400: #94A3B8;
      --v-slate-300: #CBD5E1;
      --v-slate-200: #E2E8F0;
      --v-slate-100: #F1F5F9;
      --v-slate-50:  #F8FAFC;

      --v-violet-950: #321669;
      --v-violet-900: #4A2390;
      --v-violet-800: #5C2FB2;
      --v-violet-700: #7240CC;
      --v-violet-600: #8A5BE0;
      --v-violet-500: #9878EA;
      --v-violet-400: #B8A6F1;
      --v-violet-300: #D4C8F7;
      --v-violet-200: #E8E1FB;
      --v-violet-100: #F4F0FD;

      --v-indigo-950: #180F66;
      --v-indigo-600: #5B4EFF;

      --v-emerald-600: #18B07A;
      --v-amber-500: #FAC426;
      --v-rose-600: #E84060;

      --bg: var(--v-slate-950);
      --surface: var(--v-slate-900);
      --surface-raised: var(--v-slate-800);
      --border: var(--v-slate-700);
      --border-subtle: rgba(51, 65, 85, 0.5);
      --text: var(--v-slate-50);
      --text-secondary: var(--v-slate-400);
      --text-muted: var(--v-slate-500);
      --accent: var(--v-violet-600);
      --accent-dim: rgba(138, 91, 224, 0.12);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
    }

    body::before {
      content: "";
      position: fixed;
      top: -20%;
      left: 50%;
      transform: translateX(-50%);
      width: 120%;
      height: 50%;
      background: radial-gradient(
        ellipse at center,
        rgba(138, 91, 224, 0.06) 0%,
        rgba(91, 78, 255, 0.02) 50%,
        transparent 70%
      );
      pointer-events: none;
    }

    .wrap {
      position: relative;
      z-index: 1;
      max-width: 680px;
      margin: 0 auto;
      padding: 36px 24px 64px;
      display: flex;
      flex-direction: column;
      gap: 0;
    }

    .hero {
      text-align: center;
      padding: 20px 16px 36px;
    }

    .hero-greeting {
      font-size: 13px;
      font-weight: 500;
      color: var(--v-violet-400);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }

    .hero h1 {
      font-size: 32px;
      font-weight: 800;
      letter-spacing: -0.03em;
      line-height: 1.1;
      background: linear-gradient(180deg, #fff 30%, var(--v-slate-300) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 8px;
    }

    .hero p {
      color: var(--text-muted);
      font-size: 14px;
      line-height: 1.5;
      max-width: 440px;
      margin: 0 auto;
    }

    .hero-chips {
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 16px;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 12px;
      background: var(--surface);
      border: 1px solid var(--border-subtle);
      border-radius: 999px;
      font-size: 11px;
      color: var(--text-muted);
    }

    .accent {
      color: var(--v-violet-400);
      font-weight: 600;
    }

    .section {
      margin-top: 8px;
    }

    .section-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 20px 0 12px;
    }

    .section-header h2 {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
    }

    .section-header::after {
      content: "";
      flex: 1;
      height: 1px;
      background: var(--border-subtle);
    }

    .card-stack {
      display: flex;
      flex-direction: column;
      gap: 10px;
      list-style: none;
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border-subtle);
      border-radius: 14px;
      padding: 18px 20px;
      display: flex;
      gap: 16px;
      align-items: flex-start;
      transition: border-color 0.15s ease, box-shadow 0.2s ease, transform 0.15s ease;
    }

    .card:hover {
      border-color: var(--border);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
      transform: translateY(-1px);
    }

    .card-icon {
      font-size: 28px;
      line-height: 1;
      flex-shrink: 0;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--surface-raised);
      border-radius: 10px;
    }

    .card-body {
      flex: 1;
      min-width: 0;
    }

    .task {
      font-weight: 600;
      font-size: 14px;
      color: var(--text);
      line-height: 1.3;
    }

    .task-meta {
      margin-top: 3px;
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1.4;
    }

    .card.feature {
      background: linear-gradient(135deg, var(--v-slate-900) 0%, var(--v-slate-800) 100%);
      border-color: var(--border);
      padding: 22px 24px;
    }

    .card.feature:hover {
      border-color: rgba(138, 91, 224, 0.3);
      box-shadow: 0 4px 24px rgba(138, 91, 224, 0.08), 0 4px 20px rgba(0, 0, 0, 0.2);
    }

    .card.feature .card-icon {
      background: var(--accent-dim);
      font-size: 24px;
      width: 44px;
      height: 44px;
      border-radius: 12px;
    }

    .card.feature .task {
      font-size: 15px;
    }

    .task-controls {
      margin-top: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .color-picker-wrap {
      display: inline-flex;
      align-items: center;
    }

    .color-picker-wrap input[type="color"] {
      width: 36px;
      height: 36px;
      border: 2px solid var(--border);
      border-radius: 10px;
      padding: 3px;
      background: var(--v-slate-950);
      cursor: pointer;
      transition: border-color 0.15s ease;
    }

    .color-picker-wrap input[type="color"]:hover {
      border-color: var(--accent);
    }

    .color-picker-wrap input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; }
    .color-picker-wrap input[type="color"]::-webkit-color-swatch { border: none; border-radius: 5px; }

    .task-button {
      font-family: inherit;
      border-radius: 8px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
      border: 1px solid transparent;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .task-button:active { transform: scale(0.97); }

    .task-button.primary {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
      box-shadow: 0 1px 4px rgba(138, 91, 224, 0.3);
    }

    .task-button.primary:hover {
      background: var(--v-violet-700);
      border-color: var(--v-violet-700);
      box-shadow: 0 2px 12px rgba(138, 91, 224, 0.4);
    }

    .task-button.secondary {
      background: transparent;
      color: var(--v-violet-400);
      border-color: var(--border);
    }

    .task-button.secondary:hover {
      border-color: var(--accent);
      background: var(--accent-dim);
      color: var(--v-violet-300);
    }

    .task-note {
      margin-top: 6px;
      font-size: 11px;
      color: var(--text-muted);
    }

    .onboarding-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      list-style: none;
    }

    .onboarding-card {
      background: var(--surface);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 8px;
      transition: border-color 0.15s ease, box-shadow 0.2s ease, transform 0.15s ease;
    }

    .onboarding-card:hover {
      border-color: var(--border);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
      transform: translateY(-1px);
    }

    .onboarding-card .card-icon {
      background: var(--surface-raised);
      width: 44px;
      height: 44px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
    }

    .onboarding-card .task {
      font-size: 12px;
      font-weight: 600;
      line-height: 1.3;
    }

    .onboarding-card .task-meta {
      font-size: 11px;
      margin-top: 0;
      line-height: 1.35;
    }

    .onboarding-card .task-controls {
      margin-top: auto;
      padding-top: 4px;
    }

    .onboarding-card .task-button {
      font-size: 11px;
      padding: 5px 12px;
    }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .anim { animation: fadeUp 0.45s ease-out both; }
    .anim-d1 { animation-delay: 0.0s; }
    .anim-d2 { animation-delay: 0.06s; }
    .anim-d3 { animation-delay: 0.12s; }
    .anim-d4 { animation-delay: 0.18s; }
    .anim-d5 { animation-delay: 0.24s; }
    .anim-d6 { animation-delay: 0.30s; }
    .anim-d7 { animation-delay: 0.36s; }
    .anim-d8 { animation-delay: 0.42s; }

    @media (max-width: 600px) {
      .wrap { padding: 24px 16px 48px; }
      .onboarding-grid { grid-template-columns: repeat(2, 1fr); }
      .card { flex-direction: column; gap: 10px; }
      .card.feature { flex-direction: column; }
    }
  </style>
</head>
<body>
  <main id="home-base-root" data-vellum-home-base="v1" class="wrap">

    <section class="hero anim anim-d1">
      <div class="hero-greeting">Home Base</div>
      <h1>I thought of a few ways to help</h1>
      <p>Your customizable command center. Ask your assistant to change anything here.</p>
      <div class="hero-chips">
        <span class="chip">Surface: <span class="accent">Dashboard</span></span>
        <span class="chip">Chat: <span class="accent">Docked</span></span>
      </div>
    </section>

    <section class="section" id="home-base-starter-lane">
      <div class="section-header anim anim-d2"><h2>Get started</h2></div>

      <div class="card-stack">
        <div class="card feature anim anim-d3">
          <div class="card-icon">&#x1F50D;</div>
          <div class="card-body">
            <div class="task">Research something for me</div>
            <div class="task-meta">Your assistant gathers and summarizes findings on any topic.</div>
            <div class="task-controls">
              <button id="home-base-research-start" class="task-button primary" type="button">Start research</button>
            </div>
          </div>
        </div>

        <div class="card feature anim anim-d4">
          <div class="card-icon">&#x1F310;</div>
          <div class="card-body">
            <div class="task">Turn it into a webpage</div>
            <div class="task-meta">Describe an idea and watch it become an interactive UI.</div>
            <div class="task-controls">
              <button id="home-base-web-start" class="task-button primary" type="button">Start building</button>
            </div>
          </div>
        </div>

        <div class="card feature anim anim-d5">
          <div class="card-icon">&#x1F3A8;</div>
          <div class="card-body">
            <div class="task">Change the look and feel</div>
            <div class="task-meta">Pick a color and let the assistant restyle your dashboard.</div>
            <div class="task-controls">
              <div class="color-picker-wrap">
                <input id="home-base-color-input" class="task-input" type="color" value="#8A5BE0" />
              </div>
              <button id="home-base-look-start" class="task-button primary" type="button">Customize</button>
              <button id="home-base-look-confirm" class="task-button secondary" type="button" style="display:none;">Confirm</button>
              <button id="home-base-look-cancel" class="task-button secondary" type="button" style="display:none;">Cancel</button>
            </div>
            <div class="task-note" id="home-base-look-note">Pick a color, then start the assistant flow.</div>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="home-base-onboarding-lane">
      <div class="section-header anim anim-d6"><h2>Set up your assistant</h2></div>

      <ul class="onboarding-grid">
        <li class="onboarding-card anim anim-d6">
          <div class="card-icon">&#x270F;&#xFE0F;</div>
          <div class="task">Make it mine</div>
          <div class="task-meta">Tune appearance to your style.</div>
        </li>
        <li class="onboarding-card anim anim-d7">
          <div class="card-icon">&#x1F399;&#xFE0F;</div>
          <div class="task">Voice mode</div>
          <div class="task-meta">Talk hands-free.</div>
          <div class="task-controls">
            <button id="home-base-enable-voice-start" class="task-button secondary" type="button">Enable</button>
          </div>
        </li>
        <li class="onboarding-card anim anim-d7">
          <div class="card-icon">&#x1F5A5;&#xFE0F;</div>
          <div class="task">Computer control</div>
          <div class="task-meta">Interact with your screen.</div>
          <div class="task-controls">
            <button id="home-base-enable-computer-start" class="task-button secondary" type="button">Enable</button>
          </div>
        </li>
        <li class="onboarding-card anim anim-d8">
          <div class="card-icon">&#x1F441;&#xFE0F;</div>
          <div class="task">Ambient mode</div>
          <div class="task-meta">Support while you work.</div>
          <div class="task-controls">
            <button id="home-base-enable-ambient-start" class="task-button secondary" type="button">Enable</button>
          </div>
        </li>
      </ul>
    </section>

  </main>
  <script>
    (function () {
      function sendAction(actionId, data) {
        if (window.vellum && typeof window.vellum.sendAction === 'function') {
          window.vellum.sendAction(actionId, data || {});
        }
      }

      function sendPrompt(prompt, metadata) {
        var cleanedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
        if (!cleanedPrompt) return;
        var payload = Object.assign(
          {
            prompt: cleanedPrompt,
            source: 'home_base',
          },
          metadata || {}
        );
        sendAction('relay_prompt', payload);
      }

      function byId(id) {
        return document.getElementById(id);
      }

      var colorInput = byId('home-base-color-input');
      var lookStart = byId('home-base-look-start');
      var lookConfirm = byId('home-base-look-confirm');
      var lookCancel = byId('home-base-look-cancel');
      var lookNote = byId('home-base-look-note');

      function colorPayload() {
        return {
          accentColor: colorInput && colorInput.value ? colorInput.value : '#8A5BE0',
          scope: 'full_dashboard'
        };
      }

      if (lookStart) {
        lookStart.addEventListener('click', function () {
          var color = colorPayload().accentColor;
          sendPrompt(
            'Help me customize my Home Base dashboard appearance. Start a color-first flow around "' + color + '". Ask for confirmation before applying updates.',
            {
              task: 'change_look_and_feel',
              accentColor: color,
              scope: 'full_dashboard'
            }
          );
          if (lookConfirm) lookConfirm.style.display = 'inline-flex';
          if (lookCancel) lookCancel.style.display = 'inline-flex';
          if (lookNote) lookNote.textContent = 'Assistant will ask for confirmation before applying.';
        });
      }

      if (lookConfirm) {
        lookConfirm.addEventListener('click', function () {
          var color = colorPayload().accentColor;
          sendPrompt(
            'Confirm and apply the pending Home Base color update across the full dashboard using "' + color + '".',
            {
              task: 'apply_look_and_feel',
              accentColor: color,
              scope: 'full_dashboard'
            }
          );
        });
      }

      if (lookCancel) {
        lookCancel.addEventListener('click', function () {
          sendPrompt(
            'Cancel the pending Home Base color customization and keep the current dashboard style unchanged.',
            {
              task: 'cancel_look_and_feel'
            }
          );
          if (lookConfirm) lookConfirm.style.display = 'none';
          lookCancel.style.display = 'none';
          if (lookNote) lookNote.textContent = 'Pick a color, then start the assistant flow.';
        });
      }

      var researchStart = byId('home-base-research-start');
      if (researchStart) {
        researchStart.addEventListener('click', function () {
          sendPrompt('I want you to research something for me. Ask me what topic I would like you to research.', {
            task: 'starter_research'
          });
        });
      }

      var webStart = byId('home-base-web-start');
      if (webStart) {
        webStart.addEventListener('click', function () {
          sendPrompt('I want to turn an idea into a webpage or interactive UI. Ask me what I would like to build.', {
            task: 'starter_webpage'
          });
        });
      }

      var voiceStart = byId('home-base-enable-voice-start');
      if (voiceStart) {
        voiceStart.addEventListener('click', function () {
          sendPrompt('Help me enable voice mode as an optional onboarding task.', {
            task: 'enable_voice_mode',
            source: 'home_base_onboarding_lane'
          });
        });
      }

      var computerStart = byId('home-base-enable-computer-start');
      if (computerStart) {
        computerStart.addEventListener('click', function () {
          sendPrompt('Help me enable computer control as an optional onboarding task.', {
            task: 'enable_computer_control',
            source: 'home_base_onboarding_lane'
          });
        });
      }

      var ambientStart = byId('home-base-enable-ambient-start');
      if (ambientStart) {
        ambientStart.addEventListener('click', function () {
          sendPrompt('Help me set up ambient mode as an optional onboarding task.', {
            task: 'try_ambient_mode',
            source: 'home_base_onboarding_lane'
          });
        });
      }
    })();
  </script>
</body>
</html>`;
