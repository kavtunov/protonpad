const listEl = document.getElementById("plugin-list");
const platformLine = document.getElementById("platform-line");
const catalogCount = document.getElementById("catalog-count");
const detailEmpty = document.getElementById("detail-empty");
const detailPanel = document.getElementById("detail-panel");
const toastEl = document.getElementById("toast");
const refreshBtn = document.getElementById("refresh-btn");
const syncBtn = document.getElementById("sync-btn");

let selectedId = null;
let allPlugins = [];
let osFilter = "all";
let hostOs = "darwin";

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2600);
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(str) {
  return escapeHtml(str).replaceAll("'", "&#39;");
}

function hostLabel(host) {
  if (host === "linux") return "Linux";
  if (host === "win32") return "Windows";
  if (host === "darwin") return "macOS";
  return host;
}

function stripClass(plugin) {
  if (plugin.running) return "is-running";
  if (plugin.compatible) return "is-ok";
  return "is-blocked";
}

function rowPrimary(plugin) {
  const actions = plugin.actions || {};
  if (actions.install) {
    return {
      act: "install",
      label: actions.install.label || "Install",
      disabled: !plugin.compatible,
      primary: true,
    };
  }
  return {
    act: "clone",
    label: plugin.cloned ? "Downloaded" : "Download",
    disabled: Boolean(plugin.cloned),
    primary: !plugin.cloned,
  };
}

function filteredPlugins() {
  if (osFilter === "all") return allPlugins;
  return allPlugins.filter((p) => (p.hosts || []).includes(osFilter));
}

function renderRow(plugin) {
  const hosts = plugin.hosts || [];
  const chips = hosts
    .map((h) => {
      const match = h === hostOs ? "match" : "miss";
      return `<span class="host-chip ${match}">${hostLabel(h)}</span>`;
    })
    .join("");

  let dot = "";
  if (plugin.running) dot = `<span class="status-dot run" title="running"></span>`;
  else if (plugin.installed || plugin.cloned)
    dot = `<span class="status-dot ok" title="available locally"></span>`;

  const primary = rowPrimary(plugin);

  return `
    <div
      class="mod-row ${plugin.id === selectedId ? "is-selected" : ""}"
      data-id="${plugin.id}"
      role="button"
      tabindex="0"
    >
      <span class="compat-strip ${stripClass(plugin)}" aria-hidden="true"></span>
      <span class="row-main">
        <span class="row-name">${escapeHtml(plugin.name)}</span>
        <span class="row-meta">${escapeHtml(plugin.game || plugin.platform || "")}</span>
      </span>
      <span class="row-side">
        ${chips}${dot}
        <button
          type="button"
          class="btn ${primary.primary ? "btn-primary" : "btn-ghost"} btn-row"
          data-act="${primary.act}"
          data-id="${plugin.id}"
          ${primary.disabled ? "disabled" : ""}
        >${escapeHtml(primary.label)}</button>
      </span>
    </div>
  `;
}

function renderDetail(plugin) {
  if (!plugin) {
    detailEmpty.hidden = false;
    detailEmpty.removeAttribute("aria-hidden");
    detailPanel.hidden = true;
    detailPanel.innerHTML = "";
    return;
  }

  detailEmpty.hidden = true;
  detailEmpty.setAttribute("aria-hidden", "true");
  detailPanel.hidden = false;

  const flags = [];
  if (plugin.source?.startsWith("github:")) flags.push(`<span class="flag ok">GitHub</span>`);
  if (plugin.cloned) flags.push(`<span class="flag ok">downloaded</span>`);
  if (plugin.installed) flags.push(`<span class="flag ok">installed</span>`);
  if (plugin.running) flags.push(`<span class="flag run">running</span>`);
  if (!plugin.compatible) {
    flags.push(
      `<span class="flag warn">needs ${escapeHtml(
        (plugin.hosts || []).map(hostLabel).join(" / "),
      )}</span>`,
    );
  }

  const actions = plugin.actions || {};
  const buttons = [];

  if (!actions.install) {
    buttons.push(
      `<button type="button" class="btn btn-ghost" data-act="clone" data-id="${plugin.id}" ${plugin.cloned ? "disabled" : ""}>Download repo</button>`,
    );
  } else if (!plugin.cloned) {
    buttons.push(
      `<button type="button" class="btn btn-ghost" data-act="clone" data-id="${plugin.id}">Download repo</button>`,
    );
  }

  if (actions.start) {
    buttons.push(
      `<button type="button" class="btn" data-act="start" data-id="${plugin.id}" ${plugin.compatible && !plugin.running ? "" : "disabled"}>${escapeHtml(actions.start.label)}</button>`,
    );
  }
  if (actions.settings) {
    buttons.push(
      `<button type="button" class="btn" data-act="settings" data-id="${plugin.id}" ${plugin.compatible ? "" : "disabled"}>${escapeHtml(actions.settings.label)}</button>`,
    );
  }
  if (plugin.stoppable) {
    buttons.push(
      `<button type="button" class="btn btn-danger" data-act="stop" data-id="${plugin.id}" ${plugin.running ? "" : "disabled"}>Stop</button>`,
    );
  }

  const launch = plugin.launchOptions
    ? `<div class="launch-block">
        <p class="launch-label">Steam Launch Options</p>
        <div class="launch-row">
          <code>${escapeHtml(plugin.launchOptions)}</code>
          <button type="button" class="btn" data-copy="${escapeAttr(plugin.launchOptions)}">Copy</button>
        </div>
        <p class="tip">${escapeHtml(plugin.steamTip || "")}</p>
      </div>`
    : `<p class="tip">${escapeHtml(plugin.steamTip || "See the repository README for install steps.")}</p>`;

  const platformMeta = plugin.platform
    ? `<p class="detail-meta">${escapeHtml(plugin.platform)}</p>`
    : "";

  detailPanel.innerHTML = `
    <h2 class="detail-title">${escapeHtml(plugin.name)}</h2>
    ${platformMeta}
    <p class="detail-summary">${escapeHtml(plugin.summary || "")}</p>
    <div class="detail-flags">${flags.join("")}</div>
    <div class="action-rail">${buttons.join("")}</div>
    ${launch}
  `;
}

function pulseStrips() {
  for (const strip of listEl.querySelectorAll(".compat-strip")) {
    strip.classList.remove("is-pulse");
    // reflow to restart animation
    void strip.offsetWidth;
    strip.classList.add("is-pulse");
  }
}

function renderList() {
  const items = filteredPlugins();
  catalogCount.textContent = `${items.length} of ${allPlugins.length}`;

  if (!items.length) {
    listEl.innerHTML = `<div class="empty">No mods for this filter. Switch OS or hit Sync GitHub.</div>`;
    if (!allPlugins.some((p) => p.id === selectedId)) {
      selectedId = null;
      renderDetail(null);
    }
    return;
  }

  if (!items.some((p) => p.id === selectedId)) {
    selectedId = items[0].id;
  }

  listEl.innerHTML = items.map(renderRow).join("");
  const selected = allPlugins.find((p) => p.id === selectedId) || null;
  renderDetail(selected);
}

async function loadPlugins() {
  const [{ plugins }, health] = await Promise.all([
    api("/api/plugins"),
    api("/api/health"),
  ]);

  allPlugins = plugins;
  hostOs = health.platform;
  const syncInfo = health.syncedAt
    ? `sync ${new Date(health.syncedAt).toLocaleString("en-US")}`
    : "not synced";
  platformLine.textContent = `${health.platform} · @${health.githubUser} · ${syncInfo}`;
  renderList();
}

async function runAction(id, action) {
  selectedId = id;
  renderList();
  try {
    if (action === "clone") {
      await api(`/api/plugins/${id}/clone`, { method: "POST" });
      toast("Downloaded");
    } else {
      await api(`/api/plugins/${id}/action/${action}`, { method: "POST" });
      toast(action === "stop" ? "Stopped" : "Done");
    }
  } catch (err) {
    toast(err.message);
    throw err;
  } finally {
    await loadPlugins();
  }
}

async function handleActionClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const copy = target.getAttribute("data-copy");
  if (copy) {
    event.stopPropagation();
    await navigator.clipboard.writeText(copy);
    toast("Copied");
    return;
  }

  const act = target.getAttribute("data-act");
  const id = target.getAttribute("data-id");
  if (!act || !id) return;

  event.stopPropagation();
  target.disabled = true;
  try {
    await runAction(id, act);
  } catch {
    /* toasted */
  }
}

listEl.addEventListener("click", (event) => {
  const actionBtn = event.target.closest("[data-act]");
  if (actionBtn) {
    handleActionClick(event);
    return;
  }

  const row = event.target.closest(".mod-row");
  if (!row) return;
  selectedId = row.dataset.id;
  renderList();
});

listEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest(".mod-row");
  if (!row || event.target.closest("[data-act]")) return;
  event.preventDefault();
  selectedId = row.dataset.id;
  renderList();
});

detailPanel.addEventListener("click", handleActionClick);

document.querySelector(".filter-bar").addEventListener("click", (event) => {
  const btn = event.target.closest("[data-filter]");
  if (!btn) return;
  osFilter = btn.dataset.filter;
  for (const el of document.querySelectorAll(".filter")) {
    el.classList.toggle("is-active", el === btn);
  }
  renderList();
});

refreshBtn.addEventListener("click", () => {
  loadPlugins().catch((err) => toast(err.message));
});

syncBtn.addEventListener("click", async () => {
  syncBtn.disabled = true;
  syncBtn.textContent = "Syncing…";
  try {
    const result = await api("/api/sync", { method: "POST" });
    toast(`GitHub: ${result.foundOnGithub} · total ${result.totalInApp}`);
    await loadPlugins();
    pulseStrips();
  } catch (err) {
    toast(err.message);
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = "Sync GitHub";
  }
});

let knownPluginIds = new Set();

async function refreshFromAutoSync() {
  const before = knownPluginIds.size;
  const prevIds = new Set(knownPluginIds);
  await loadPlugins();
  knownPluginIds = new Set(allPlugins.map((p) => p.id));
  if (before > 0) {
    const added = [...knownPluginIds].filter((id) => !prevIds.has(id));
    if (added.length) {
      toast(`New mod${added.length > 1 ? "s" : ""} from GitHub: ${added.length}`);
      pulseStrips();
    }
  }
}

loadPlugins()
  .then(() => {
    knownPluginIds = new Set(allPlugins.map((p) => p.id));
  })
  .catch((err) => {
    listEl.innerHTML = `<div class="empty">Error: ${escapeHtml(err.message)}</div>`;
  });

// Pick up server auto-sync without pressing the button.
setInterval(() => {
  refreshFromAutoSync().catch(() => {});
}, 60_000);
