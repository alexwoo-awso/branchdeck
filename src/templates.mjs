export function renderLoginPage({ csrfToken, error, next }) {
  return pageTemplate({
    title: "Sign in",
    bodyClass: "login-page",
    body: `
      <section class="auth-shell">
        <div class="auth-panel auth-panel-wide">
          <div class="auth-copy">
            <p class="eyebrow">Control plane</p>
            <h1>Run the site and manage it from one place.</h1>
            <p class="muted lead">Use the local admin account to configure the repo, restart the runtime, and wire up Decap OAuth when you need it.</p>
            <ul class="feature-list">
              <li>Admin panel on port <strong>8080</strong></li>
              <li>Application runtime on port <strong>8888</strong></li>
              <li>Settings stored persistently in SQLite</li>
            </ul>
          </div>
          <div class="auth-card">
            <p class="eyebrow">Admin sign in</p>
            ${error ? `<p class="flash flash-error">${escapeHtml(error)}</p>` : ""}
            <form method="post" action="/login" class="stack">
              <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
              <input type="hidden" name="next" value="${escapeHtml(next || "/admin")}">
              <label>
                <span>Username</span>
                <input name="username" autocomplete="username" required>
              </label>
              <label>
                <span>Password</span>
                <input type="password" name="password" autocomplete="current-password" required>
              </label>
              <button type="submit">Sign in</button>
            </form>
          </div>
        </div>
      </section>
    `,
  });
}

export function renderAdminPage({ csrfToken, settings, status, appUrl, adminUsername, flashMessage, flashError }) {
  const oauthBase = settings.publicBaseUrl ? `${settings.publicBaseUrl}/auth` : "https://your-domain.example/auth";
  const callbackUrl = settings.publicBaseUrl ? `${settings.publicBaseUrl}/callback` : "https://your-domain.example/callback";
  const setupComplete = Boolean(settings.gitRepoUrl);
  const runtimeTone = status.ok ? "good" : setupComplete ? "warn" : "idle";

  return pageTemplate({
    title: "Admin",
    bodyClass: "admin-page",
    body: `
      <section class="hero-shell">
        <div class="hero-copy">
          <p class="eyebrow">Branchdeck</p>
          <h1>Control plane for branch previews, local runtime, and editor auth.</h1>
          <p class="muted lead">Configure the repo once, keep the admin panel separate from the site runtime, and use the dashboard to see what the service is doing right now.</p>
        </div>
        <div class="hero-actions">
          <a class="button link-button" href="/app">Open app</a>
          <form method="post" action="/admin/actions/sync">
            <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
            <button type="submit">Sync now</button>
          </form>
          <form method="post" action="/admin/actions/restart">
            <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
            <button type="submit" class="ghost">Restart runtime</button>
          </form>
          <form method="post" action="/logout">
            <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
            <button type="submit" class="ghost">Log out</button>
          </form>
        </div>
      </section>

      ${flashMessage ? `<p class="flash">${escapeHtml(flashMessage)}</p>` : ""}
      ${flashError ? `<p class="flash flash-error">${escapeHtml(flashError)}</p>` : ""}

      <section class="dashboard-grid">
        <article class="panel panel-status panel-${runtimeTone}">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Runtime status</p>
              <h2>${status.ok ? "App is reachable" : "Setup still in progress"}</h2>
            </div>
            <span class="status-pill status-pill-${runtimeTone}">${escapeHtml(status.lastSyncStatus || "unknown")}</span>
          </div>
          <dl class="metric-grid">
            ${metric("Application", `<a href="${escapeHtml(appUrl)}" target="_blank" rel="noreferrer">${escapeHtml(appUrl)}</a>`)}
            ${metric("Branch", escapeHtml(status.branch))}
            ${metric("Commit", `<code>${escapeHtml(status.currentRef || "n/a")}</code>`)}
            ${metric("Last sync", escapeHtml(status.lastSyncAt || "n/a"))}
            ${metric("Public auth", escapeHtml(status.publicAuthMode))}
            ${metric("Ready", status.ok ? "yes" : "no")}
          </dl>
          <p class="helper">${setupComplete ? "The repo is configured. If the app is still not ready, inspect the status here and restart the runtime after changing settings." : "Start by entering a Git repository URL below. The admin panel will stay available even before the site runtime is ready."}</p>
        </article>

        <article class="panel panel-checklist">
          <p class="eyebrow">First-time setup</p>
          <h2>What to fill in first</h2>
          <ol class="checklist">
            <li class="${settings.gitRepoUrl ? "is-done" : ""}">Set <strong>Git repository URL</strong> and the branch you want to serve.</li>
            <li class="${settings.installCmd ? "is-done" : ""}">Keep the install command that fits the repo. For most npm projects, <code>npm ci</code> is enough.</li>
            <li class="${settings.publicBaseUrl ? "is-done" : ""}">Add <strong>Public base URL</strong> only when you need OAuth callbacks or an external reverse proxy.</li>
            <li class="${settings.githubOAuthClientId ? "is-done" : ""}">Configure GitHub OAuth only if Decap CMS needs login through this service.</li>
          </ol>
          <div class="inline-note">
            <span class="note-label">Ports</span>
            <p>Admin panel: <strong>8080</strong>. Site runtime: <strong>8888</strong>.</p>
          </div>
        </article>
      </section>

      <section class="content-grid">
        <section class="panel panel-form">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Configuration</p>
              <h2>Project and runtime settings</h2>
            </div>
            <p class="helper">Secrets can be left blank to keep the current stored value.</p>
          </div>

          <form method="post" action="/admin/settings" class="stack gap-xl">
            <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">

            ${settingsGroup("Repository", "Define what repo to clone and how dependencies should be installed.", `
              <div class="field-grid field-grid-wide">
                ${input("Git repository URL", "gitRepoUrl", settings.gitRepoUrl, "https://github.com/org/repo.git")}
                ${input("Git branch", "gitBranch", settings.gitBranch, "main")}
                ${input("Repo subdir", "repoSubdir", settings.repoSubdir, "apps/site")}
                ${input("Install command", "installCmd", settings.installCmd, "npm ci")}
                ${input("Git clone depth", "gitCloneDepth", String(settings.gitCloneDepth), "1")}
                ${input("Git auth username", "gitAuthUsername", settings.gitAuthUsername, "x-access-token")}
                ${password("Git auth token", "gitAuthToken")}
                ${input("Sync interval seconds", "syncIntervalSeconds", String(settings.syncIntervalSeconds), "15")}
              </div>
            `)}

            ${settingsGroup("Runtime", "Control how the embedded netlify dev runtime is launched for the checked-out project.", `
              <div class="field-grid">
                ${input("Netlify internal port", "netlifyPort", String(settings.netlifyPort), "8999")}
                ${input("Netlify context", "netlifyContext", settings.netlifyContext, "branch:main")}
                ${input("Framework override", "netlifyFramework", settings.netlifyFramework, "next")}
                ${input("Target port", "netlifyTargetPort", settings.netlifyTargetPort ? String(settings.netlifyTargetPort) : "", "3000")}
                ${input("Functions dir", "netlifyFunctions", settings.netlifyFunctions, "netlify/functions")}
                ${input("Publish dir", "netlifyDir", settings.netlifyDir, "dist")}
                ${input("Custom command", "netlifyCommand", settings.netlifyCommand, "npm run dev")}
                ${input("Extra dev args", "netlifyDevArgs", settings.netlifyDevArgs.join(" "), "--offline")}
                ${select("Offline mode", "netlifyOffline", String(Boolean(settings.netlifyOffline)), [["false", "False"], ["true", "True"]])}
                ${input("Netlify site ID", "netlifySiteId", settings.netlifySiteId, "")}
                ${password("Netlify auth token", "netlifyAuthToken")}
                ${select("Log level", "logLevel", settings.logLevel, [["error", "error"], ["warn", "warn"], ["info", "info"], ["debug", "debug"]])}
              </div>
            `)}

            ${settingsGroup("Public access", "These options affect the public-facing app, not the admin panel.", `
              <div class="field-grid">
                ${input("Public base URL", "publicBaseUrl", settings.publicBaseUrl, "https://dev.example.com")}
                ${select("Public auth mode", "publicAuthMode", settings.publicAuthMode, [["off", "Off"], ["basic", "HTTP Basic auth"], ["session", "Admin session"]])}
                ${input("Public auth username", "publicAuthUsername", settings.publicAuthUsername, "editor")}
                ${password("Public auth password", "publicAuthPassword")}
                ${select("Trust proxy headers", "trustProxyHeaders", String(Boolean(settings.trustProxyHeaders)), [["true", "True"], ["false", "False"]])}
              </div>
            `)}

            ${settingsGroup("GitHub OAuth", "Only needed when Decap CMS should authenticate through this service.", `
              <div class="field-grid">
                ${input("GitHub OAuth client ID", "githubOAuthClientId", settings.githubOAuthClientId, "")}
                ${password("GitHub OAuth client secret", "githubOAuthClientSecret")}
                ${input("GitHub OAuth scope", "githubOAuthScope", settings.githubOAuthScope, "repo,user")}
              </div>
            `)}

            <div class="form-actions">
              <button type="submit">Save settings</button>
              <p class="helper">After saving, the runtime reloads automatically.</p>
            </div>
          </form>
        </section>

        <aside class="side-stack">
          <article class="panel">
            <p class="eyebrow">Decap CMS</p>
            <h2>Backend snippet</h2>
            <pre><code>backend:
  name: github
  repo: owner/repo
  branch: ${escapeHtml(settings.gitBranch)}
  base_url: ${escapeHtml(oauthBase)}</code></pre>
            <p class="helper">GitHub OAuth callback URL: <code>${escapeHtml(callbackUrl)}</code></p>
          </article>

          <article class="panel">
            <p class="eyebrow">Admin account</p>
            <h2>Credentials</h2>
            <form method="post" action="/admin/password" class="stack">
              <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
              ${input("Username", "adminUsername", adminUsername, "admin")}
              ${password("New password", "adminPassword")}
              <button type="submit">Update credentials</button>
            </form>
          </article>
        </aside>
      </section>
    `,
  });
}

export function renderOAuthSuccessPage({ provider, token, origin }) {
  const payload = JSON.stringify({ token, provider });
  const targetOrigin = JSON.stringify(origin || "*");
  const successMessage = JSON.stringify(`authorization:${provider}:success:${payload}`);
  const authorizingMessage = JSON.stringify(`authorizing:${provider}`);

  return pageTemplate({
    title: "OAuth complete",
    bodyClass: "login-page",
    body: `
      <section class="auth-shell">
        <div class="auth-panel">
          <p class="eyebrow">GitHub OAuth</p>
          <h1>Authorization complete</h1>
          <p class="muted lead">You can close this window if it does not close automatically.</p>
        </div>
      </section>
      <script>
        const targetOrigin = ${targetOrigin};
        const successMessage = ${successMessage};
        function complete() {
          if (!window.opener) {
            return;
          }
          window.opener.postMessage(successMessage, targetOrigin);
          setTimeout(() => window.close(), 150);
        }
        if (window.opener) {
          window.opener.postMessage(${authorizingMessage}, targetOrigin);
          window.addEventListener("message", complete, { once: true });
          setTimeout(complete, 600);
        }
      </script>
    `,
  });
}

export function renderOAuthErrorPage(message) {
  return pageTemplate({
    title: "OAuth error",
    bodyClass: "login-page",
    body: `
      <section class="auth-shell">
        <div class="auth-panel">
          <p class="eyebrow">GitHub OAuth</p>
          <h1>Authorization failed</h1>
          <p class="flash flash-error">${escapeHtml(message)}</p>
        </div>
      </section>
    `,
  });
}

function input(label, name, value, placeholder) {
  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <input name="${escapeHtml(name)}" value="${escapeHtml(value || "")}" placeholder="${escapeHtml(placeholder || "")}">
    </label>
  `;
}

function password(label, name) {
  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <input type="password" name="${escapeHtml(name)}" placeholder="leave blank to keep current value">
    </label>
  `;
}

function select(label, name, currentValue, options) {
  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <select name="${escapeHtml(name)}">
        ${options.map(([value, text]) => `<option value="${escapeHtml(value)}" ${value === currentValue ? "selected" : ""}>${escapeHtml(text)}</option>`).join("")}
      </select>
    </label>
  `;
}

function settingsGroup(title, description, content) {
  return `
    <section class="settings-group">
      <div class="settings-heading">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(description)}</p>
      </div>
      ${content}
    </section>
  `;
}

function metric(label, value) {
  return `
    <div class="metric">
      <dt>${label}</dt>
      <dd>${value}</dd>
    </div>
  `;
}

function pageTemplate({ title, body, bodyClass = "" }) {
  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${escapeHtml(title)}</title>
      <style>
        :root {
          --bg: #f7f4ec;
          --panel: rgba(255, 251, 244, 0.88);
          --panel-strong: rgba(255, 249, 239, 0.96);
          --ink: #1a1e17;
          --muted: #5c6558;
          --line: rgba(47, 57, 42, 0.14);
          --accent: #1d5c48;
          --accent-strong: #113d2f;
          --accent-soft: rgba(29, 92, 72, 0.10);
          --sand: #d4b483;
          --warn: #8d5b24;
          --danger: #8a3020;
          --shadow: 0 24px 80px rgba(30, 39, 27, 0.12);
          --radius-lg: 28px;
          --radius-md: 18px;
          --radius-sm: 12px;
        }
        * { box-sizing: border-box; }
        html { scroll-behavior: smooth; }
        body {
          margin: 0;
          color: var(--ink);
          font-family: "Palatino Linotype", "Book Antiqua", Palatino, serif;
          background:
            radial-gradient(circle at top left, rgba(29, 92, 72, 0.18), transparent 32%),
            radial-gradient(circle at 85% 15%, rgba(212, 180, 131, 0.28), transparent 24%),
            linear-gradient(180deg, #faf6ef 0%, #f3eee2 100%);
          min-height: 100vh;
        }
        body::before {
          content: "";
          position: fixed;
          inset: 0;
          pointer-events: none;
          background-image:
            linear-gradient(rgba(26, 30, 23, 0.025) 1px, transparent 1px),
            linear-gradient(90deg, rgba(26, 30, 23, 0.025) 1px, transparent 1px);
          background-size: 32px 32px;
          mask-image: radial-gradient(circle at center, black 50%, transparent 88%);
        }
        main {
          width: min(1320px, calc(100vw - 2rem));
          margin: 0 auto;
          padding: 28px 0 56px;
          position: relative;
          z-index: 1;
        }
        h1, h2, h3, p { margin-top: 0; }
        h1 {
          font-size: clamp(2.6rem, 5vw, 4.6rem);
          line-height: 0.94;
          letter-spacing: -0.04em;
          margin-bottom: 1rem;
          max-width: 12ch;
        }
        h2 {
          font-size: 1.5rem;
          line-height: 1.08;
          margin-bottom: 0.6rem;
        }
        h3 {
          font-size: 1.02rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-bottom: 0.35rem;
        }
        .eyebrow {
          margin-bottom: 0.85rem;
          text-transform: uppercase;
          letter-spacing: 0.18em;
          font-size: 0.72rem;
          color: var(--muted);
        }
        .lead {
          font-size: 1.04rem;
          line-height: 1.6;
          max-width: 62ch;
        }
        .muted, .helper {
          color: var(--muted);
        }
        .helper {
          font-size: 0.93rem;
          line-height: 1.55;
        }
        .hero-shell, .panel, .auth-panel, .auth-card {
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow);
          backdrop-filter: blur(12px);
        }
        .hero-shell {
          display: grid;
          grid-template-columns: minmax(0, 1.5fr) minmax(280px, 0.85fr);
          gap: 1.25rem;
          padding: 1.5rem;
          margin-bottom: 1rem;
        }
        .hero-copy {
          display: grid;
          align-content: start;
        }
        .hero-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 0.75rem;
          align-content: start;
          justify-content: flex-end;
        }
        .dashboard-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.8fr);
          gap: 1rem;
          margin-bottom: 1rem;
        }
        .content-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.5fr) minmax(300px, 0.72fr);
          gap: 1rem;
        }
        .side-stack,
        .stack {
          display: grid;
          gap: 1rem;
        }
        .gap-xl { gap: 1.3rem; }
        .panel {
          padding: 1.25rem;
        }
        .panel-header {
          display: flex;
          justify-content: space-between;
          align-items: start;
          gap: 1rem;
          margin-bottom: 1rem;
        }
        .panel-status {
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.48), transparent),
            var(--panel-strong);
        }
        .panel-good { border-color: rgba(29, 92, 72, 0.24); }
        .panel-warn { border-color: rgba(141, 91, 36, 0.24); }
        .panel-idle { border-color: rgba(92, 101, 88, 0.18); }
        .status-pill {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.5rem 0.8rem;
          border-radius: 999px;
          font-size: 0.82rem;
          white-space: nowrap;
          border: 1px solid var(--line);
          background: rgba(255, 255, 255, 0.68);
        }
        .status-pill-good {
          color: var(--accent-strong);
          border-color: rgba(29, 92, 72, 0.22);
          background: rgba(29, 92, 72, 0.08);
        }
        .status-pill-warn {
          color: var(--warn);
          border-color: rgba(141, 91, 36, 0.22);
          background: rgba(141, 91, 36, 0.08);
        }
        .status-pill-idle {
          color: var(--muted);
        }
        .metric-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 0.9rem;
          margin: 0 0 1rem;
        }
        .metric {
          padding: 0.9rem 1rem;
          border-radius: var(--radius-md);
          background: rgba(255, 255, 255, 0.55);
          border: 1px solid rgba(47, 57, 42, 0.08);
          min-height: 92px;
        }
        .metric dt {
          margin-bottom: 0.35rem;
          font-size: 0.78rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .metric dd {
          margin: 0;
          line-height: 1.45;
          word-break: break-word;
        }
        .checklist {
          margin: 0;
          padding-left: 1.2rem;
          display: grid;
          gap: 0.85rem;
          line-height: 1.5;
        }
        .checklist li {
          color: var(--ink);
        }
        .checklist li.is-done {
          color: var(--accent-strong);
        }
        .inline-note {
          margin-top: 1rem;
          padding: 1rem;
          border-radius: var(--radius-md);
          background: rgba(29, 92, 72, 0.07);
          border: 1px solid rgba(29, 92, 72, 0.12);
        }
        .note-label {
          display: inline-block;
          margin-bottom: 0.35rem;
          font-size: 0.74rem;
          text-transform: uppercase;
          letter-spacing: 0.14em;
          color: var(--accent);
        }
        .settings-group {
          padding: 1.1rem;
          border-radius: 22px;
          background: rgba(255, 255, 255, 0.46);
          border: 1px solid rgba(47, 57, 42, 0.09);
        }
        .settings-heading {
          margin-bottom: 0.95rem;
        }
        .settings-heading p {
          margin-bottom: 0;
          color: var(--muted);
          line-height: 1.5;
        }
        .field-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 0.95rem;
        }
        .field-grid-wide {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .field {
          display: grid;
          gap: 0.42rem;
        }
        .field > span {
          font-size: 0.86rem;
          color: var(--muted);
        }
        input, select, button, .link-button {
          width: 100%;
          min-height: 48px;
          border-radius: var(--radius-sm);
          border: 1px solid rgba(47, 57, 42, 0.15);
          background: rgba(255, 255, 255, 0.92);
          color: var(--ink);
          padding: 0.82rem 0.95rem;
          font: inherit;
        }
        input:focus, select:focus {
          outline: none;
          border-color: rgba(29, 92, 72, 0.45);
          box-shadow: 0 0 0 4px rgba(29, 92, 72, 0.10);
        }
        button, .button {
          width: auto;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 0.45rem;
          background: var(--accent);
          color: #f8f4eb;
          border: none;
          text-decoration: none;
          transition: transform 140ms ease, background 140ms ease, box-shadow 140ms ease;
          box-shadow: 0 10px 22px rgba(17, 61, 47, 0.16);
        }
        button:hover, .button:hover {
          transform: translateY(-1px);
          background: var(--accent-strong);
        }
        button.ghost {
          background: rgba(29, 92, 72, 0.08);
          color: var(--accent);
          border: 1px solid rgba(29, 92, 72, 0.15);
          box-shadow: none;
        }
        a {
          color: var(--accent);
          text-decoration-thickness: 1px;
          text-underline-offset: 0.12em;
        }
        .form-actions {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 0.9rem;
        }
        .flash {
          border-radius: var(--radius-md);
          padding: 0.95rem 1rem;
          background: rgba(29, 92, 72, 0.10);
          border: 1px solid rgba(29, 92, 72, 0.16);
          margin-bottom: 1rem;
        }
        .flash-error {
          background: rgba(138, 48, 32, 0.10);
          border-color: rgba(138, 48, 32, 0.16);
          color: var(--danger);
        }
        pre {
          margin: 0;
          padding: 1rem;
          border-radius: 20px;
          overflow: auto;
          background: #182019;
          color: #e9f4ed;
          border: 1px solid rgba(255, 255, 255, 0.06);
        }
        code {
          font-family: "SFMono-Regular", Consolas, monospace;
          font-size: 0.92em;
        }
        .auth-shell {
          min-height: calc(100vh - 56px);
          display: grid;
          place-items: center;
        }
        .auth-panel {
          width: min(1100px, 100%);
          padding: 1.5rem;
          display: grid;
          grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.85fr);
          gap: 1rem;
        }
        .auth-panel-wide {
          background:
            linear-gradient(135deg, rgba(29, 92, 72, 0.10), transparent 42%),
            var(--panel);
        }
        .auth-copy {
          padding: 1rem;
          display: grid;
          align-content: center;
        }
        .auth-card {
          padding: 1.25rem;
          background: rgba(255, 255, 255, 0.62);
        }
        .feature-list {
          margin: 0;
          padding-left: 1.2rem;
          display: grid;
          gap: 0.5rem;
          color: var(--muted);
        }
        .login-page main {
          width: min(1180px, calc(100vw - 2rem));
        }
        @media (max-width: 1080px) {
          .hero-shell, .dashboard-grid, .content-grid, .auth-panel {
            grid-template-columns: 1fr;
          }
          .hero-actions {
            justify-content: start;
          }
        }
        @media (max-width: 760px) {
          main {
            width: min(100vw - 1rem, 1320px);
            padding-top: 14px;
          }
          .hero-shell, .panel, .auth-panel, .auth-card {
            border-radius: 22px;
          }
          .metric-grid, .field-grid, .field-grid-wide {
            grid-template-columns: 1fr;
          }
          .panel-header, .form-actions {
            flex-direction: column;
            align-items: start;
          }
          h1 {
            max-width: none;
          }
        }
      </style>
    </head>
    <body class="${escapeHtml(bodyClass)}">
      <main>${body}</main>
    </body>
  </html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
