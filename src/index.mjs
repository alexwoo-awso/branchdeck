import crypto from "node:crypto";
import express from "express";
import session from "express-session";
import http from "node:http";
import httpProxy from "http-proxy";
import { parse as parseCookie } from "cookie";
import signature from "cookie-signature";
import { AppStore } from "./store.mjs";
import { RuntimeManager, normalizeSettings } from "./runtime.mjs";
import { renderAdminPage, renderLoginPage, renderOAuthErrorPage, renderOAuthSuccessPage } from "./templates.mjs";

const envConfig = {
  port: numberFromEnv("PORT", 8080),
  repoDir: env("REPO_DIR", "/workspace/site"),
  netlifyStateDir: env("NETLIFY_STATE_DIR", "/workspace/netlify-state"),
  databasePath: env("DATABASE_PATH", "/workspace/data/app.db"),
  sessionSecret: env("SESSION_SECRET", crypto.randomBytes(32).toString("hex")),
  adminUsername: env("ADMIN_USERNAME", "admin"),
  adminPassword: env("ADMIN_PASSWORD", "change-me-now"),
  appPort: numberFromEnv("APP_PORT", 8888),
  logLevel: env("LOG_LEVEL", "info"),
};

const store = new AppStore(envConfig.databasePath);
store.bootstrap({
  settings: normalizeSettings({
    publicBaseUrl: env("PUBLIC_BASE_URL", ""),
    trustProxyHeaders: env("TRUST_PROXY_HEADERS", "true"),
    logLevel: env("LOG_LEVEL", "info"),
    publicAuthMode: env("PUBLIC_AUTH_MODE", "off"),
    publicAuthUsername: env("PUBLIC_AUTH_USERNAME", ""),
    publicAuthPassword: env("PUBLIC_AUTH_PASSWORD", ""),
    gitRepoUrl: env("GIT_REPO_URL", ""),
    gitBranch: env("GIT_BRANCH", "develop"),
    gitCloneDepth: env("GIT_CLONE_DEPTH", "1"),
    gitAuthToken: env("GIT_AUTH_TOKEN", ""),
    gitAuthUsername: env("GIT_AUTH_USERNAME", "x-access-token"),
    gitPollStrategy: env("GIT_POLL_STRATEGY", "hard-reset"),
    syncIntervalSeconds: env("SYNC_INTERVAL_SECONDS", "15"),
    repoSubdir: env("REPO_SUBDIR", ""),
    installCmd: env("INSTALL_CMD", ""),
    netlifyPort: env("NETLIFY_PORT", "8888"),
    netlifyContext: env("NETLIFY_CONTEXT", ""),
    netlifySiteId: env("NETLIFY_SITE_ID", ""),
    netlifyAuthToken: env("NETLIFY_AUTH_TOKEN", ""),
    netlifyFramework: env("NETLIFY_FRAMEWORK", ""),
    netlifyTargetPort: env("NETLIFY_TARGET_PORT", ""),
    netlifyFunctions: env("NETLIFY_FUNCTIONS", ""),
    netlifyDir: env("NETLIFY_DIR", ""),
    netlifyCommand: env("NETLIFY_COMMAND", ""),
    netlifyDevArgs: env("NETLIFY_DEV_ARGS", ""),
    netlifyOffline: env("NETLIFY_OFFLINE", "false"),
    githubOAuthClientId: env("GITHUB_OAUTH_CLIENT_ID", ""),
    githubOAuthClientSecret: env("GITHUB_OAUTH_CLIENT_SECRET", ""),
    githubOAuthScope: env("GITHUB_OAUTH_SCOPE", "repo,user"),
  }),
  adminUsername: envConfig.adminUsername,
  adminPassword: envConfig.adminPassword,
});

const runtime = new RuntimeManager({ envConfig, store, logger: log });
await runtime.start();

const app = express();
const publicApp = express();
const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true, xfwd: true });
const sessionMiddleware = session({
  name: "branchdeck.sid",
  secret: envConfig.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});

app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false }));
app.use(sessionMiddleware);
publicApp.use(sessionMiddleware);

app.use((req, res, next) => {
  if (req.session?.cookie) {
    req.session.cookie.secure = forwardedProto(req) === "https";
  }
  next();
});
publicApp.use((req, res, next) => {
  if (req.session?.cookie) {
    req.session.cookie.secure = forwardedProto(req) === "https";
  }
  next();
});

app.get("/__health", (req, res) => {
  res.status(runtime.getStatus().ok ? 200 : 503).json(runtime.getStatus());
});

app.get("/", (req, res) => {
  res.redirect("/admin");
});

app.get("/login", (req, res) => {
  res.type("html").send(renderLoginPage({
    csrfToken: csrfTokenFor(req),
    error: req.session.flashError,
    next: req.query.next || "/admin",
  }));
  clearFlash(req);
});

app.post("/login", (req, res) => {
  if (!validateCsrf(req)) {
    res.status(403).type("html").send(renderLoginPage({
      csrfToken: csrfTokenFor(req),
      error: "Invalid CSRF token.",
      next: req.body.next || "/admin",
    }));
    return;
  }

  const username = String(req.body.username || "");
  const password = String(req.body.password || "");
  if (!store.verifyAdmin(username, password)) {
    res.status(401).type("html").send(renderLoginPage({
      csrfToken: csrfTokenFor(req),
      error: "Invalid username or password.",
      next: req.body.next || "/admin",
    }));
    return;
  }

  req.session.isAdmin = true;
  req.session.adminUsername = username;
  res.redirect(String(req.body.next || "/admin"));
});

app.post("/logout", requireAdmin, (req, res) => {
  if (!validateCsrf(req)) {
    res.status(403).send("Forbidden");
    return;
  }
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/admin", requireAdmin, (req, res) => {
  const settings = store.getSettings();
  const admin = store.getAdminUser();
  res.type("html").send(renderAdminPage({
    csrfToken: csrfTokenFor(req),
    settings: normalizeSettings(settings),
    status: runtime.getStatus(),
    appUrl: currentAppUrl(req),
    adminUsername: admin.username,
    flashMessage: req.session.flashMessage,
    flashError: req.session.flashError,
  }));
  clearFlash(req);
});

app.get("/api/status", requireAdmin, (req, res) => {
  res.json({
    status: runtime.getStatus(),
    settings: redactSecrets(store.getSettings()),
    admin: store.getAdminUser(),
  });
});

app.post("/admin/settings", requireAdmin, async (req, res) => {
  if (!validateCsrf(req)) {
    setFlash(req, "", "Invalid CSRF token.");
    res.redirect("/admin");
    return;
  }

  try {
    const current = store.getSettings();
    const merged = normalizeSettings({
      ...current,
      publicBaseUrl: req.body.publicBaseUrl,
      trustProxyHeaders: req.body.trustProxyHeaders,
      logLevel: req.body.logLevel,
      publicAuthMode: req.body.publicAuthMode,
      publicAuthUsername: req.body.publicAuthUsername,
      publicAuthPassword: req.body.publicAuthPassword || current.publicAuthPassword,
      gitRepoUrl: req.body.gitRepoUrl,
      gitBranch: req.body.gitBranch,
      gitCloneDepth: req.body.gitCloneDepth,
      gitAuthToken: req.body.gitAuthToken || current.gitAuthToken,
      gitAuthUsername: req.body.gitAuthUsername,
      gitPollStrategy: current.gitPollStrategy,
      syncIntervalSeconds: req.body.syncIntervalSeconds,
      repoSubdir: req.body.repoSubdir,
      installCmd: req.body.installCmd,
      netlifyPort: req.body.netlifyPort,
      netlifyContext: req.body.netlifyContext,
      netlifySiteId: req.body.netlifySiteId,
      netlifyAuthToken: req.body.netlifyAuthToken || current.netlifyAuthToken,
      netlifyFramework: req.body.netlifyFramework,
      netlifyTargetPort: req.body.netlifyTargetPort,
      netlifyFunctions: req.body.netlifyFunctions,
      netlifyDir: req.body.netlifyDir,
      netlifyCommand: req.body.netlifyCommand,
      netlifyDevArgs: req.body.netlifyDevArgs,
      netlifyOffline: req.body.netlifyOffline,
      githubOAuthClientId: req.body.githubOAuthClientId,
      githubOAuthClientSecret: req.body.githubOAuthClientSecret || current.githubOAuthClientSecret,
      githubOAuthScope: req.body.githubOAuthScope,
    });

    validateSettings(merged);
    store.saveSettings(merged);
    await runtime.reload();
    setFlash(req, "Settings saved and runtime reloaded.", "");
  } catch (error) {
    setFlash(req, "", error.message);
  }

  res.redirect("/admin");
});

app.post("/admin/password", requireAdmin, (req, res) => {
  if (!validateCsrf(req)) {
    setFlash(req, "", "Invalid CSRF token.");
    res.redirect("/admin");
    return;
  }

  const username = String(req.body.adminUsername || "").trim();
  const password = String(req.body.adminPassword || "");
  if (!username || !password) {
    setFlash(req, "", "Username and new password are required.");
    res.redirect("/admin");
    return;
  }

  store.updateAdminCredentials(username, password);
  req.session.adminUsername = username;
  setFlash(req, "Admin credentials updated.", "");
  res.redirect("/admin");
});

app.post("/admin/actions/sync", requireAdmin, async (req, res) => {
  if (!validateCsrf(req)) {
    setFlash(req, "", "Invalid CSRF token.");
    res.redirect("/admin");
    return;
  }
  try {
    await runtime.forceSync();
    setFlash(req, "Repository sync completed.", "");
  } catch (error) {
    setFlash(req, "", error.message);
  }
  res.redirect("/admin");
});

app.post("/admin/actions/restart", requireAdmin, async (req, res) => {
  if (!validateCsrf(req)) {
    setFlash(req, "", "Invalid CSRF token.");
    res.redirect("/admin");
    return;
  }
  try {
    await runtime.restart();
    setFlash(req, "Netlify runtime restarted.", "");
  } catch (error) {
    setFlash(req, "", error.message);
  }
  res.redirect("/admin");
});

app.get("/auth", enforcePublicAccess, async (req, res) => {
  try {
    const settings = normalizeSettings(store.getSettings());
    if (!settings.publicBaseUrl) {
      throw new Error("PUBLIC_BASE_URL must be configured before GitHub OAuth can be used.");
    }
    if (!settings.githubOAuthClientId || !settings.githubOAuthClientSecret) {
      throw new Error("GitHub OAuth is not configured.");
    }

    store.cleanupOAuthState();
    const state = store.createOAuthState("github", deriveOrigin(req, settings.publicBaseUrl));
    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", settings.githubOAuthClientId);
    authorizeUrl.searchParams.set("redirect_uri", `${settings.publicBaseUrl}/callback`);
    authorizeUrl.searchParams.set("scope", settings.githubOAuthScope);
    authorizeUrl.searchParams.set("state", state);
    res.redirect(authorizeUrl.toString());
  } catch (error) {
    res.status(500).type("html").send(renderOAuthErrorPage(error.message));
  }
});

app.get("/callback", enforcePublicAccess, async (req, res) => {
  try {
    if (req.query.error) {
      throw new Error(String(req.query.error_description || req.query.error));
    }

    const settings = normalizeSettings(store.getSettings());
    const state = String(req.query.state || "");
    const code = String(req.query.code || "");
    if (!state || !code) {
      throw new Error("Missing OAuth state or code.");
    }

    const oauthState = store.consumeOAuthState(state);
    if (!oauthState) {
      throw new Error("OAuth state is invalid or expired.");
    }

    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: settings.githubOAuthClientId,
        client_secret: settings.githubOAuthClientSecret,
        code,
        state,
        redirect_uri: `${settings.publicBaseUrl}/callback`,
      }),
    });

    const tokenPayload = await tokenResponse.json();
    if (!tokenResponse.ok || tokenPayload.error) {
      throw new Error(tokenPayload.error_description || tokenPayload.error || "GitHub token exchange failed.");
    }

    res.type("html").send(renderOAuthSuccessPage({
      provider: "github",
      token: tokenPayload.access_token,
      origin: oauthState.origin,
    }));
  } catch (error) {
    res.status(500).type("html").send(renderOAuthErrorPage(error.message));
  }
});

app.get("/app", (req, res) => {
  const appUrl = currentAppUrl(req);
  if (!runtime.getStatus().ok) {
    res.status(503).type("text/plain").send(`Branchdeck app runtime is not ready yet.\nApplication URL: ${appUrl}\n`);
    return;
  }
  res.redirect(appUrl);
});

app.use((req, res) => {
  res.status(404).type("text/plain").send(`Admin panel lives on this port.\nLogin: /login\nAdmin: /admin\nApplication: ${currentAppUrl(req)}\n`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

publicApp.use((req, res) => {
  if (!runtime.getStatus().ok) {
    res.status(503).type("text/plain").send("Branchdeck app runtime is not ready yet.\n");
    return;
  }
  if (!allowPublicRequest(req, res)) {
    return;
  }
  proxy.web(req, res, { target: runtime.currentProxyTarget() });
});

proxy.on("error", (error, req, res) => {
  log("error", `proxy request failed: ${error.message}`);
  if (!res.headersSent) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
  }
  res.end("Upstream application runtime is unavailable.\n");
});

const server = http.createServer(app);
const publicServer = http.createServer(publicApp);

server.listen(envConfig.port, "0.0.0.0", () => {
  log("info", `control plane listening on 0.0.0.0:${envConfig.port}`);
});
publicServer.listen(envConfig.appPort, "0.0.0.0", () => {
  log("info", `public app proxy listening on 0.0.0.0:${envConfig.appPort}`);
});

publicServer.on("upgrade", async (req, socket, head) => {
  const fakeRes = {
    headersSent: false,
    writeHead(statusCode, headers) {
      socket.write(`HTTP/1.1 ${statusCode} Unauthorized\r\n`);
      for (const [key, value] of Object.entries(headers || {})) {
        socket.write(`${key}: ${value}\r\n`);
      }
      socket.write("\r\n");
    },
    end(message = "") {
      if (message) {
        socket.write(message);
      }
      socket.destroy();
    },
  };

  if (!runtime.getStatus().ok) {
    fakeRes.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    fakeRes.end("Branchdeck app runtime is not ready yet.\n");
    return;
  }
  if (!(await allowPublicUpgrade(req, fakeRes))) {
    return;
  }
  proxy.ws(req, socket, head, { target: runtime.currentProxyTarget() });
});

async function shutdown() {
  await runtime.shutdown();
  let remaining = 2;
  const done = () => {
    remaining -= 1;
    if (remaining === 0) {
      process.exit(0);
    }
  };
  server.close(done);
  publicServer.close(done);
}

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) {
    next();
    return;
  }
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function enforcePublicAccess(req, res, next) {
  if (allowPublicRequest(req, res)) {
    next();
  }
}

function allowPublicRequest(req, res) {
  const settings = normalizeSettings(store.getSettings());
  if (settings.publicAuthMode === "off") {
    return true;
  }
  if (settings.publicAuthMode === "session") {
    if (req.session?.isAdmin) {
      return true;
    }
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return false;
  }
  if (settings.publicAuthMode === "basic") {
    const header = req.headers.authorization || "";
    if (checkBasicAuth(header, settings.publicAuthUsername, settings.publicAuthPassword)) {
      return true;
    }
    res.setHeader("www-authenticate", 'Basic realm="Branchdeck", charset="UTF-8"');
    res.status(401).send("Authentication required.\n");
    return false;
  }
  return true;
}

async function allowPublicUpgrade(req, res) {
  const settings = normalizeSettings(store.getSettings());
  if (settings.publicAuthMode === "off") {
    return true;
  }

  if (settings.publicAuthMode === "basic") {
    const header = req.headers.authorization || "";
    if (checkBasicAuth(header, settings.publicAuthUsername, settings.publicAuthPassword)) {
      return true;
    }
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Branchdeck", charset="UTF-8"' });
    res.end();
    return false;
  }

  if (settings.publicAuthMode === "session") {
    const sessionData = await loadSessionFromUpgrade(req);
    if (sessionData?.isAdmin) {
      return true;
    }
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    res.end("Authentication required.\n");
    return false;
  }

  return true;
}

function checkBasicAuth(header, expectedUsername, expectedPassword) {
  if (!expectedUsername || !expectedPassword || !header.startsWith("Basic ")) {
    return false;
  }
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return false;
  }
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return safeEqual(username, expectedUsername) && safeEqual(password, expectedPassword);
}

function validateSettings(settings) {
  if (settings.publicAuthMode === "basic" && (!settings.publicAuthUsername || !settings.publicAuthPassword)) {
    throw new Error("HTTP Basic auth mode requires a username and password.");
  }
  if (!settings.gitBranch) {
    throw new Error("Git branch is required.");
  }
  if ((settings.githubOAuthClientId || settings.githubOAuthClientSecret) && !settings.publicBaseUrl) {
    throw new Error("Public base URL is required.");
  }
}

function redactSecrets(settings) {
  return {
    ...settings,
    publicAuthPassword: settings.publicAuthPassword ? "configured" : "",
    gitAuthToken: settings.gitAuthToken ? "configured" : "",
    netlifyAuthToken: settings.netlifyAuthToken ? "configured" : "",
    githubOAuthClientSecret: settings.githubOAuthClientSecret ? "configured" : "",
  };
}

function csrfTokenFor(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString("hex");
  }
  return req.session.csrfToken;
}

function validateCsrf(req) {
  return Boolean(req.body?._csrf) && safeEqual(String(req.body._csrf), String(csrfTokenFor(req)));
}

function setFlash(req, message, error) {
  req.session.flashMessage = message;
  req.session.flashError = error;
}

function clearFlash(req) {
  delete req.session.flashMessage;
  delete req.session.flashError;
}

function deriveOrigin(req, publicBaseUrl) {
  const queryOrigin = String(req.query.origin || "").trim();
  if (queryOrigin) {
    return queryOrigin;
  }
  try {
    return new URL(publicBaseUrl).origin;
  } catch {
    return "*";
  }
}

function forwardedProto(req) {
  return String(req.headers["x-forwarded-proto"] || req.protocol || "http");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

async function loadSessionFromUpgrade(req) {
  const cookies = parseCookie(req.headers.cookie || "");
  const raw = cookies["branchdeck.sid"];
  if (!raw) {
    return null;
  }

  const unsigned = unsignSessionId(raw, envConfig.sessionSecret);
  if (!unsigned) {
    return null;
  }

  return await new Promise((resolve) => {
    sessionMiddleware.store.get(unsigned, (error, sessionData) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(sessionData || null);
    });
  });
}

function currentAppUrl(req) {
  const protocol = forwardedProto(req);
  const host = String(req.headers.host || "");
  const hostname = host.split(":")[0] || "127.0.0.1";
  return `${protocol}://${hostname}:${envConfig.appPort}`;
}

function unsignSessionId(cookieValue, secret) {
  const normalized = cookieValue.startsWith("s:") ? cookieValue.slice(2) : cookieValue;
  return signature.unsign(normalized, secret) || false;
}

function env(name, fallback) {
  return process.env[name] || fallback;
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
}

function log(level, message) {
  const severity = { error: 0, warn: 1, info: 2, debug: 3 };
  const configured = severity[envConfig.logLevel] ?? severity.info;
  if ((severity[level] ?? severity.info) > configured) {
    return;
  }
  console.log(`[${level}] ${message}`);
}
