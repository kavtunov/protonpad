import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_BRANCHES = ["main", "master"];

function normalizePlugin(raw, source) {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.id || !raw.name || !raw.repo) return null;

  const repoDir =
    raw.repoDir ||
    String(raw.repo)
      .replace(/\/$/, "")
      .split("/")
      .filter(Boolean)
      .pop();

  return {
    id: String(raw.id),
    name: String(raw.name),
    game: raw.game || "",
    platform: raw.platform || "",
    hosts: Array.isArray(raw.hosts) && raw.hosts.length ? raw.hosts : ["linux"],
    summary: raw.summary || raw.description || "",
    repo: String(raw.repo),
    repoDir: String(repoDir),
    launchOptions: raw.launchOptions ?? "",
    steamTip: raw.steamTip || "",
    actions: raw.actions && typeof raw.actions === "object" ? raw.actions : {},
    stoppable: Boolean(raw.stoppable),
    source,
  };
}

function mergePlugins(localList, remoteList) {
  const map = new Map();
  for (const plugin of localList) {
    map.set(plugin.id, plugin);
  }
  for (const plugin of remoteList) {
    // Remote (GitHub) wins on same id — that's the live catalog.
    map.set(plugin.id, plugin);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function githubFetch(url, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ProtonPad",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

async function listUserRepos(user, token) {
  const repos = [];
  let page = 1;

  while (page <= 5) {
    const res = await githubFetch(
      `https://api.github.com/users/${encodeURIComponent(user)}/repos?per_page=100&page=${page}&sort=updated`,
      token,
    );
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos.push(...batch.filter((r) => !r.fork && !r.archived));
    if (batch.length < 100) break;
    page += 1;
  }

  return repos;
}

async function fetchRepoCatalog(owner, repoName, catalogFile, token) {
  for (const branch of DEFAULT_BRANCHES) {
    const url = `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}/${catalogFile}`;
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "ProtonPad",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const items = Array.isArray(data) ? data : [data];
      return items
        .map((item) =>
          normalizePlugin(
            {
              ...item,
              repo: item.repo || `https://github.com/${owner}/${repoName}`,
              repoDir: item.repoDir || repoName,
            },
            `github:${owner}/${repoName}`,
          ),
        )
        .filter(Boolean);
    } catch {
      // try next branch / skip
    }
  }
  return [];
}

export async function loadLocalManifest(manifestPath) {
  const raw = await readJsonFile(manifestPath, []);
  return raw
    .map((item) => normalizePlugin(item, "local"))
    .filter(Boolean);
}

export async function loadCachedRemote(cachePath) {
  const cached = await readJsonFile(cachePath, null);
  if (!cached?.plugins) return [];
  return cached.plugins
    .map((item) => normalizePlugin(item, item.source || "cache"))
    .filter(Boolean);
}

export async function syncFromGitHub({
  githubUser,
  catalogFile,
  cachePath,
  token = process.env.GITHUB_TOKEN,
}) {
  const repos = await listUserRepos(githubUser, token);
  const remote = [];

  for (const repo of repos) {
    const found = await fetchRepoCatalog(
      repo.owner.login,
      repo.name,
      catalogFile,
      token,
    );
    remote.push(...found);
  }

  const payload = {
    syncedAt: new Date().toISOString(),
    githubUser,
    count: remote.length,
    plugins: remote,
  };

  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(payload, null, 2));

  return payload;
}

export async function getMergedCatalog({
  manifestPath,
  cachePath,
}) {
  const local = await loadLocalManifest(manifestPath);
  const remote = await loadCachedRemote(cachePath);
  return {
    plugins: mergePlugins(local, remote),
    localCount: local.length,
    remoteCount: remote.length,
  };
}

export function isHostCompatible(plugin, hostOs) {
  const hosts = plugin.hosts?.length ? plugin.hosts : ["linux"];
  return hosts.includes(hostOs);
}
