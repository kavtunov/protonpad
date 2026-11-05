# ProtonPad

Local hub for gaming mods/fixes (Linux + Windows): sync catalog from GitHub, download, install, copy Steam launch options, run helpers.

## Run

```bash
cd protonpad
npm install
npm start
```

Open: [http://127.0.0.1:4787](http://127.0.0.1:4787)

## Auto-sync

On startup (and every 15 minutes by default) ProtonPad scans public repos of `githubUser` from `plugins/config.json` and loads any root `protonpad.json`.

Manual **Sync GitHub** still works. Tune in `plugins/config.json`:

```json
"autoSync": {
  "enabled": true,
  "onStartup": true,
  "intervalMinutes": 15
}
```

## Add a new mod on GitHub

Put `protonpad.json` in the **repo root**:

```json
{
  "id": "my-mod",
  "name": "My Mod",
  "game": "Some Game",
  "platform": "Windows",
  "hosts": ["win32"],
  "summary": "What it does",
  "steamTip": "How to install"
}
```

`hosts`: `"linux"` and/or `"win32"`. Optional: `GITHUB_TOKEN` for higher GitHub API limits.
