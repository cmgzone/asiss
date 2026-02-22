# Install Gitu from GitHub

## Prerequisites
- Node.js 18+ (recommended)
- npm 9+

## Option 1: Global install (recommended)
Replace `OWNER/REPO` with your GitHub repository, for example `cmgzone/asiss`.

```bash
npm install -g github:OWNER/REPO
```

Then in your project/workspace folder:

```bash
gitu wizard
gitu start
```

## Option 2: Run without global install
```bash
npx github:OWNER/REPO wizard
npx github:OWNER/REPO start
```

## Windows npm 11 fallback (if `github:OWNER/REPO` creates a broken `gitu` command)
Use the GitHub tarball URL and skip install scripts:

```bash
npm install -g --ignore-scripts https://codeload.github.com/OWNER/REPO/tar.gz/refs/heads/main
```

## Notes
- `gitu wizard` creates/updates `config.json` and `.env` in your current folder.
- `gitu start` launches the assistant and web UI (default: `http://localhost:3000`).
