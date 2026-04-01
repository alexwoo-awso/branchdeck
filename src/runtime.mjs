import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";

export class RuntimeManager {
  constructor({ envConfig, store, logger }) {
    this.envConfig = envConfig;
    this.store = store;
    this.log = logger;
    this.state = {
      currentRef: "",
      currentFingerprint: "",
      lastSyncStatus: "booting",
      lastSyncAt: "",
      netlifyReady: false,
      netlifyPid: 0,
      shuttingDown: false,
      currentSettings: normalizeSettings(store.getSettings()),
    };
    this.netlifyProcess = null;
    this.syncTimer = null;
    this.syncInFlight = false;
  }

  async start() {
    this.ensureDirectories();
    try {
      const changed = await this.syncRepo({ initial: true });
      if (changed !== null) {
        await this.restartNetlify();
      }
    } catch (error) {
      this.state.netlifyReady = false;
      this.state.netlifyPid = 0;
      this.state.lastSyncStatus = `error: ${error.message}`;
      this.state.lastSyncAt = new Date().toISOString();
      this.log("warn", `runtime bootstrap incomplete: ${error.message}`);
    }
    this.scheduleSync();
  }

  async reload() {
    this.state.currentSettings = normalizeSettings(this.store.getSettings());
    this.ensureDirectories();
    this.scheduleSync();
    const changed = await this.syncRepo({ initial: true });
    if (changed === null) {
      await this.stopNetlify();
      this.state.netlifyReady = false;
      this.state.netlifyPid = 0;
      return;
    }
    await this.restartNetlify();
  }

  async forceSync() {
    this.state.currentSettings = normalizeSettings(this.store.getSettings());
    const changed = await this.syncRepo({ initial: false, forceRestartOnChange: true });
    if (changed === null) {
      throw new Error("Configure GIT_REPO_URL or mount a git checkout into REPO_DIR before syncing.");
    }
  }

  async restart() {
    this.state.currentSettings = normalizeSettings(this.store.getSettings());
    await this.restartNetlify();
  }

  getStatus() {
    const settings = this.state.currentSettings;
    return {
      ok: this.state.netlifyReady,
      currentRef: this.state.currentRef,
      lastSyncStatus: this.state.lastSyncStatus,
      lastSyncAt: this.state.lastSyncAt,
      netlifyPid: this.state.netlifyPid,
      repoDir: this.envConfig.repoDir,
      repoSubdir: settings.repoSubdir || ".",
      branch: settings.gitBranch,
      netlifyPort: this.effectiveNetlifyPort(),
      publicBaseUrl: settings.publicBaseUrl,
      publicAuthMode: settings.publicAuthMode,
      githubOAuthEnabled: Boolean(settings.githubOAuthClientId && settings.githubOAuthClientSecret),
    };
  }

  currentProxyTarget() {
    return `http://127.0.0.1:${this.effectiveNetlifyPort()}`;
  }

  async shutdown() {
    this.state.shuttingDown = true;
    clearInterval(this.syncTimer);
    await this.stopNetlify();
  }

  ensureDirectories() {
    fs.mkdirSync(this.envConfig.repoDir, { recursive: true });
    fs.mkdirSync(this.envConfig.netlifyStateDir, { recursive: true });
  }

  scheduleSync() {
    clearInterval(this.syncTimer);
    this.syncTimer = setInterval(() => {
      this.syncRepo({ initial: false, forceRestartOnChange: true }).catch((error) => {
        this.log("error", `background sync failed: ${error.message}`);
      });
    }, this.state.currentSettings.syncIntervalSeconds * 1000);
  }

  async syncRepo({ initial, forceRestartOnChange = false }) {
    if (this.syncInFlight || this.state.shuttingDown) {
      return;
    }

    this.syncInFlight = true;
    this.state.lastSyncStatus = "syncing";

    try {
      const changed = await this.ensureRepoUpToDate();
      if (changed === null) {
        this.state.lastSyncStatus = "waiting for repository configuration";
        this.state.lastSyncAt = new Date().toISOString();
        return null;
      }
      this.state.lastSyncStatus = changed ? "updated" : "steady";
      this.state.lastSyncAt = new Date().toISOString();

      if (!initial && changed && forceRestartOnChange) {
        this.log("info", "repository changed, restarting Netlify Dev");
        await this.restartNetlify();
      }
    } catch (error) {
      this.state.lastSyncStatus = `error: ${error.message}`;
      this.state.lastSyncAt = new Date().toISOString();
      throw error;
    } finally {
      this.syncInFlight = false;
    }
  }

  async ensureRepoUpToDate() {
    const settings = this.state.currentSettings;
    const repoExists = fs.existsSync(path.join(this.envConfig.repoDir, ".git"));

    if (!repoExists) {
      if (!settings.gitRepoUrl) {
        this.state.currentRef = "";
        this.state.currentFingerprint = "";
        return null;
      }

      this.log("info", `cloning ${maskToken(this.buildCloneUrl())}#${settings.gitBranch}`);
      await run("git", [
        "clone",
        "--branch", settings.gitBranch,
        "--single-branch",
        "--depth", String(settings.gitCloneDepth),
        this.buildCloneUrl(),
        this.envConfig.repoDir,
      ]);
      return await this.installDependenciesIfNeeded(true);
    }

    const previousRef = this.state.currentRef || (await this.gitOutput(["rev-parse", "HEAD"]));
    if (settings.gitRepoUrl) {
      await run("git", ["remote", "set-url", "origin", this.buildCloneUrl()], { cwd: this.envConfig.repoDir });
    }
    await run("git", ["fetch", "--depth", String(settings.gitCloneDepth), "origin", settings.gitBranch], { cwd: this.envConfig.repoDir });
    const remoteRef = await this.gitOutput(["rev-parse", "FETCH_HEAD"]);

    if (remoteRef === previousRef) {
      if (!this.state.currentFingerprint) {
        await this.installDependenciesIfNeeded(true);
      } else {
        await this.updateRepoState();
      }
      return false;
    }

    if (settings.gitPollStrategy !== "hard-reset") {
      throw new Error(`Unsupported GIT_POLL_STRATEGY: ${settings.gitPollStrategy}`);
    }

    await run("git", ["checkout", "-B", settings.gitBranch, "FETCH_HEAD"], { cwd: this.envConfig.repoDir });
    await run("git", ["reset", "--hard", "FETCH_HEAD"], { cwd: this.envConfig.repoDir });
    await run("git", ["clean", "-fd"], { cwd: this.envConfig.repoDir });
    return await this.installDependenciesIfNeeded(false);
  }

  async updateRepoState() {
    this.state.currentRef = await this.gitOutput(["rev-parse", "HEAD"]);
    this.state.currentFingerprint = fingerprintFiles(this.repoWorkDir(), lockFiles);
  }

  async installDependenciesIfNeeded(forceInstall) {
    const workDir = this.repoWorkDir();
    const fingerprint = fingerprintFiles(workDir, lockFiles);
    const changed = forceInstall || fingerprint !== this.state.currentFingerprint;

    if (changed) {
      const installCommand = resolveInstallCommand(workDir, this.state.currentSettings.installCmd);
      if (installCommand) {
        this.log("info", `installing dependencies with: ${installCommand}`);
        await runShell(installCommand, workDir);
      } else {
        this.log("info", "no package manager manifest found, skipping dependency install");
      }
    }

    this.state.currentFingerprint = fingerprint;
    this.state.currentRef = await this.gitOutput(["rev-parse", "HEAD"]);
    return true;
  }

  async restartNetlify() {
    const settings = this.state.currentSettings;
    await this.stopNetlify();
    this.state.netlifyReady = false;

    const args = [
      "dev",
      "--port", String(this.effectiveNetlifyPort()),
      "--no-open",
    ];

    if (settings.netlifyContext) {
      args.push("--context", settings.netlifyContext);
    }
    if (settings.netlifySiteId) {
      args.push("--site", settings.netlifySiteId);
    }
    if (settings.netlifyFramework) {
      args.push("--framework", settings.netlifyFramework);
    }
    if (settings.netlifyTargetPort) {
      args.push("--target-port", String(settings.netlifyTargetPort));
    }
    if (settings.netlifyFunctions) {
      args.push("--functions", settings.netlifyFunctions);
    }
    if (settings.netlifyDir) {
      args.push("--dir", settings.netlifyDir);
    }
    if (settings.netlifyCommand) {
      args.push("--command", settings.netlifyCommand);
    }
    if (settings.netlifyOffline) {
      args.push("--offline");
    }
    if (settings.netlifyDevArgs.length > 0) {
      args.push(...settings.netlifyDevArgs);
    }

    this.log("info", `starting netlify ${args.join(" ")}`);
    this.netlifyProcess = spawn("netlify", args, {
      cwd: this.repoWorkDir(),
      env: {
        ...process.env,
        NETLIFY_AUTH_TOKEN: settings.netlifyAuthToken || "",
        NETLIFY_SITE_ID: settings.netlifySiteId || "",
        NETLIFY_HOME: this.envConfig.netlifyStateDir,
        BROWSER: "none",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.state.netlifyPid = this.netlifyProcess.pid || 0;

    this.netlifyProcess.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(`[netlify] ${text}`);
      if (text.includes("Server now ready") || text.includes("Waiting for framework port")) {
        this.state.netlifyReady = true;
      }
    });

    this.netlifyProcess.stderr.on("data", (chunk) => {
      process.stderr.write(`[netlify] ${chunk.toString()}`);
    });

    this.netlifyProcess.on("exit", (code, signal) => {
      this.state.netlifyReady = false;
      this.state.netlifyPid = 0;
      if (!this.state.shuttingDown) {
        this.log("warn", `netlify dev exited unexpectedly (code=${code}, signal=${signal ?? "none"})`);
      }
    });

    await waitForPort(this.effectiveNetlifyPort(), 30000);
    this.state.netlifyReady = true;
  }

  async stopNetlify() {
    if (!this.netlifyProcess) {
      return;
    }

    const proc = this.netlifyProcess;
    this.netlifyProcess = null;

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      proc.once("exit", finish);
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          proc.kill("SIGKILL");
          finish();
        }
      }, 10000);
    });
  }

  repoWorkDir() {
    return this.state.currentSettings.repoSubdir
      ? path.join(this.envConfig.repoDir, this.state.currentSettings.repoSubdir)
      : this.envConfig.repoDir;
  }

  effectiveNetlifyPort() {
    const configured = this.state.currentSettings.netlifyPort;
    if (configured === this.envConfig.appPort) {
      return this.envConfig.appPort + 1;
    }
    return configured;
  }

  buildCloneUrl() {
    const settings = this.state.currentSettings;
    if (!settings.gitRepoUrl || !settings.gitAuthToken) {
      return settings.gitRepoUrl;
    }

    const url = new URL(settings.gitRepoUrl);
    if (url.protocol !== "https:") {
      throw new Error("Authenticated repository cloning requires an HTTPS URL");
    }
    url.username = settings.gitAuthUsername;
    url.password = settings.gitAuthToken;
    return url.toString();
  }

  async gitOutput(args) {
    const output = await run("git", args, { cwd: this.envConfig.repoDir, capture: true });
    return output.trim();
  }
}

const lockFiles = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];

export function normalizeSettings(input) {
  return {
    publicBaseUrl: cleanUrl(input.publicBaseUrl),
    trustProxyHeaders: booleanFromValue(input.trustProxyHeaders, true),
    logLevel: input.logLevel || "info",
    publicAuthMode: input.publicAuthMode || "off",
    publicAuthUsername: input.publicAuthUsername || "",
    publicAuthPassword: input.publicAuthPassword || "",
    gitRepoUrl: input.gitRepoUrl || "",
    gitBranch: input.gitBranch || "develop",
    gitCloneDepth: numberFromValue(input.gitCloneDepth, 1),
    gitAuthToken: input.gitAuthToken || "",
    gitAuthUsername: input.gitAuthUsername || "x-access-token",
    gitPollStrategy: input.gitPollStrategy || "hard-reset",
    syncIntervalSeconds: numberFromValue(input.syncIntervalSeconds, 15),
    repoSubdir: input.repoSubdir || "",
    installCmd: input.installCmd || "",
    netlifyPort: numberFromValue(input.netlifyPort, 8888),
    netlifyContext: input.netlifyContext || `branch:${input.gitBranch || "develop"}`,
    netlifySiteId: input.netlifySiteId || "",
    netlifyAuthToken: input.netlifyAuthToken || "",
    netlifyFramework: input.netlifyFramework || "",
    netlifyTargetPort: numberFromValue(input.netlifyTargetPort, 0),
    netlifyFunctions: input.netlifyFunctions || "",
    netlifyDir: input.netlifyDir || "",
    netlifyCommand: input.netlifyCommand || "",
    netlifyDevArgs: splitArgs(input.netlifyDevArgs || ""),
    netlifyOffline: booleanFromValue(input.netlifyOffline, false),
    githubOAuthClientId: input.githubOAuthClientId || "",
    githubOAuthClientSecret: input.githubOAuthClientSecret || "",
    githubOAuthScope: input.githubOAuthScope || "repo,user",
  };
}

function resolveInstallCommand(workDir, explicitCommand) {
  if (explicitCommand) {
    return explicitCommand;
  }
  if (!fs.existsSync(path.join(workDir, "package.json"))) {
    return "";
  }
  if (fs.existsSync(path.join(workDir, "pnpm-lock.yaml"))) {
    return "corepack enable && pnpm install --frozen-lockfile";
  }
  if (fs.existsSync(path.join(workDir, "yarn.lock"))) {
    return "corepack enable && yarn install --frozen-lockfile";
  }
  if (fs.existsSync(path.join(workDir, "package-lock.json"))) {
    return "npm ci";
  }
  return "npm install";
}

function fingerprintFiles(baseDir, relativePaths) {
  const hash = crypto.createHash("sha256");
  for (const relativePath of relativePaths) {
    const fullPath = path.join(baseDir, relativePath);
    if (fs.existsSync(fullPath)) {
      hash.update(relativePath);
      hash.update(fs.readFileSync(fullPath));
    }
  }
  return hash.digest("hex");
}

function splitArgs(value) {
  return String(value)
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function maskToken(value) {
  return value.replace(/:[^:@/]+@/g, ":***@");
}

function cleanUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function numberFromValue(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanFromValue(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

async function waitForPort(port, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ok) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for Netlify Dev on port ${port}`);
}

async function runShell(command, cwd) {
  await run("/bin/sh", ["-c", command], { cwd });
}

async function run(command, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const capture = options.capture || false;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });

    let stdout = "";
    let stderr = "";

    if (capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
    child.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
