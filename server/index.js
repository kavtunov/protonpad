import express from "express";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getMergedCatalog,
  isHostCompatible,
  syncFromGitHub,
} from "./catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.PROTONPAD_HOME || path.join(ROOT, ".data");
const PLUGINS_DIR = path.join(DATA_DIR, "plugins");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const CACHE_FILE = path.join(DATA_DIR, "remote-catalog.json");
const MANIFEST_PATH = path.join(ROOT, "plugins", "manifest.json");
const CONFIG_PATH = path.join(ROOT, "plugins", "config.json");

const running = new Map();
const logs = new Map();

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, "public")));

async function ensureDirs() {
  await fs.mkdir(PLUGINS_DIR, { recursive: true });
  try {
    await fs.access(STATE_FILE);
  } catch {
    await fs.writeFile(STATE_FILE, JSON.stringify({ plugins: {} }, null, 2));
  }
}

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  } catch {
    return { githubUser: "kavtunov", catalogFile: "protonpad.json" };
  }
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch {
    return { plugins: {} };
  }
}

async function writeState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function listPlugins() {
  const { plugins } = await getMergedCatalog({
    manifestPath: MANIFEST_PATH,
    cachePath: CACHE_FILE,
  });
  return plugins;
}

async function findPlugin(id) {
  const plugins = await listPlugins();
  return plugins.find((p) => p.id === id) || null;
}

function appendLog(pluginId, line) {
  const prev = logs.get(pluginId) ?? [];
  logs.set(pluginId, [...prev, line].slice(-200));
}

function pluginPath(plugin) {
  return path.join(PLUGINS_DIR, plugin.repoDir);
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function runCommand(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else {
        const err = new Error(
          `Command failed (${code}): ${cmd} ${args.join(" ")}\n${stderr || stdout}`,
        );
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

async function ensureCloned(plugin) {
  const dest = pluginPath(plugin);
  if (await pathExists(path.join(dest, ".git"))) {
    return { cloned: true, path: dest, updated: false };
  }

  appendLog(plugin.id, `Cloning ${plugin.repo}…`);
  await fs.mkdir(PLUGINS_DIR, { recursive: true });
  await runCommand("git", ["clone", "--depth", "1", plugin.repo, dest]);
  appendLog(plugin.id, `Cloned into ${dest}`);
  return { cloned: true, path: dest, updated: true };
}

function startDetached(plugin, action) {
  const cwd = path.join(pluginPath(plugin), action.cwd || ".");
  const child = spawn(action.cmd, action.args, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  child.stdout?.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      appendLog(plugin.id, line);
    }
  });
  child.stderr?.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      appendLog(plugin.id, `[err] ${line}`);
    }
  });

  child.on("exit", (code) => {
    appendLog(plugin.id, `Process exited with code ${code ?? "?"}`);
    running.delete(plugin.id);
  });

  child.unref();
  running.set(plugin.id, {
    pid: child.pid,
    startedAt: Date.now(),
    action: action.label,
  });
  appendLog(
    plugin.id,
    `Started PID ${child.pid}: ${action.cmd} ${action.args.join(" ")}`,
  );
  return child.pid;
}

function stopPlugin(pluginId) {
  const info = running.get(pluginId);
  if (!info?.pid) return false;

  try {
    process.kill(-info.pid, "SIGTERM");
  } catch {
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {
      return false;
    }
  }

  running.delete(pluginId);
  appendLog(pluginId, `Stopped PID ${info.pid}`);
  return true;
}

async function pluginStatus(plugin) {
  const dest = pluginPath(plugin);
  const cloned = await pathExists(path.join(dest, ".git"));
  const state = await readState();
  const installed = Boolean(state.plugins?.[plugin.id]?.installed);
  const run = running.get(plugin.id);
  const compatible = isHostCompatible(plugin, process.platform);

  return {
    ...plugin,
    localPath: dest,
    cloned,
    installed,
    running: Boolean(run),
    pid: run?.pid ?? null,
    startedAt: run?.startedAt ?? null,
    runningAction: run?.action ?? null,
    compatible,
    hostOs: process.platform,
  };
}

let lastAutoSync = {
  at: null,
  ok: null,
  foundOnGithub: null,
  error: null,
};
let syncInFlight = null;

async function runCatalogSync(reason = "manual") {
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    const config = await readConfig();
    console.log(`[sync] ${reason}: scanning @${config.githubUser}`);
    const result = await syncFromGitHub({
      githubUser: config.githubUser,
      catalogFile: config.catalogFile || "protonpad.json",
      cachePath: CACHE_FILE,
    });
    lastAutoSync = {
      at: result.syncedAt,
      ok: true,
      foundOnGithub: result.count,
      error: null,
    };
    console.log(`[sync] ${reason}: found ${result.count} remote plugin(s)`);
    return result;
  })();

  try {
    return await syncInFlight;
  } catch (err) {
    lastAutoSync = {
      at: new Date().toISOString(),
      ok: false,
      foundOnGithub: null,
      error: err.message,
    };
    console.error(`[sync] ${reason} failed:`, err.message);
    throw err;
  } finally {
    syncInFlight = null;
  }
}

function startAutoSync(config) {
  const auto = config.autoSync || {};
  if (auto.enabled === false) {
    console.log("[sync] auto-sync disabled");
    return;
  }

  if (auto.onStartup !== false) {
    runCatalogSync("startup").catch(() => {});
  }

  const minutes = Number(auto.intervalMinutes);
  const intervalMs =
    Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 15 * 60_000;

  setInterval(() => {
    runCatalogSync("interval").catch(() => {});
  }, intervalMs).unref();

  console.log(`[sync] auto-sync every ${Math.round(intervalMs / 60_000)} min`);
}

app.get("/api/health", async (_req, res) => {
  const config = await readConfig();
  let syncedAt = lastAutoSync.at;
  try {
    const cache = JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
    syncedAt = cache.syncedAt || syncedAt;
  } catch {
    /* no cache yet */
  }

  res.json({
    ok: true,
    name: "ProtonPad",
    platform: process.platform,
    dataDir: DATA_DIR,
    githubUser: config.githubUser,
    syncedAt,
    autoSync: config.autoSync || null,
    lastAutoSync,
  });
});

app.get("/api/plugins", async (_req, res) => {
  try {
    const plugins = await listPlugins();
    const items = await Promise.all(plugins.map(pluginStatus));
    res.json({ plugins: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sync", async (_req, res) => {
  try {
    const result = await runCatalogSync("manual");
    const merged = await listPlugins();
    res.json({
      ok: true,
      syncedAt: result.syncedAt,
      foundOnGithub: result.count,
      totalInApp: merged.length,
      plugins: await Promise.all(merged.map(pluginStatus)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/plugins/:id/logs", (req, res) => {
  res.json({ lines: logs.get(req.params.id) ?? [] });
});

app.post("/api/plugins/:id/clone", async (req, res) => {
  try {
    const plugin = await findPlugin(req.params.id);
    if (!plugin) return res.status(404).json({ error: "Plugin not found" });

    const result = await ensureCloned(plugin);
    res.json(result);
  } catch (err) {
    appendLog(req.params.id, `Clone failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/plugins/:id/action/:action", async (req, res) => {
  try {
    const plugin = await findPlugin(req.params.id);
    if (!plugin) return res.status(404).json({ error: "Plugin not found" });

    const actionName = req.params.action;
    if (actionName === "stop") {
      const ok = stopPlugin(plugin.id);
      return res.json({ ok, status: await pluginStatus(plugin) });
    }

    const action = plugin.actions?.[actionName];
    if (!action) {
      return res.status(404).json({ error: `Unknown action: ${actionName}` });
    }

    if (!isHostCompatible(plugin, process.platform)) {
      const hosts = (plugin.hosts || []).join(", ");
      return res.status(400).json({
        error: `This mod targets: ${hosts || "another OS"}. Current host: ${process.platform}. You can clone the repo here; install/start only on the matching OS.`,
      });
    }

    await ensureCloned(plugin);
    const cwd = path.join(pluginPath(plugin), action.cwd || ".");

    if (action.detached) {
      if (running.has(plugin.id)) {
        return res.status(409).json({ error: "Already running. Stop it first." });
      }
      const pid = startDetached(plugin, action);
      return res.json({ ok: true, pid, status: await pluginStatus(plugin) });
    }

    const steps = action.steps ?? [{ cmd: action.cmd, args: action.args }];
    for (const step of steps) {
      appendLog(plugin.id, `> ${step.cmd} ${(step.args || []).join(" ")}`);
      try {
        await runCommand(step.cmd, step.args || [], { cwd });
      } catch (err) {
        if (step.optional) {
          appendLog(plugin.id, `Optional step skipped/failed: ${err.message}`);
          continue;
        }
        throw err;
      }
    }

    const state = await readState();
    state.plugins[plugin.id] = {
      ...(state.plugins[plugin.id] || {}),
      installed: true,
      lastAction: actionName,
      lastAt: new Date().toISOString(),
    };
    await writeState(state);

    appendLog(plugin.id, `Action "${actionName}" finished`);
    res.json({ ok: true, status: await pluginStatus(plugin) });
  } catch (err) {
    appendLog(req.params.id, `Action failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

const PORT = Number(process.env.PORT) || 4787;

await ensureDirs();
const bootConfig = await readConfig();
app.listen(PORT, () => {
  console.log(`ProtonPad → http://127.0.0.1:${PORT}`);
  console.log(`Data dir  → ${DATA_DIR}`);
  startAutoSync(bootConfig);
});
