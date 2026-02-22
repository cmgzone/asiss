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

## Notes
- `gitu wizard` creates/updates `config.json` and `.env` in your current folder.
- `gitu start` launches the assistant and web UI (default: `http://localhost:3000`).
