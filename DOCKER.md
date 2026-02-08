# Docker Deployment Guide

Gitubot is fully container-ready. You can run it using Docker.

## 🚨 Prerequisites

**Docker is required** to run containers. It seems it is not currently installed or available in your path.

1. **Install Docker Desktop for Windows**:
   - Download from: [https://www.docker.com/products/docker-desktop/](https://www.docker.com/products/docker-desktop/)
   - Install and **start** Docker Desktop.
   - Ensure you can run `docker --version` in your terminal.

2. **Configuration**:
   - Ensure `config.json` and `.env` files exist (run `npm run wizard` locally first to generate them).

## Quick Start

Depending on your Docker version, the command might be `docker-compose` or `docker compose`.

1. **Build and Run**:
   ```bash
   docker compose up -d
   # OR if that fails:
   docker-compose up -d
   ```

2. **View Logs**:
   ```bash
   docker compose logs -f
   ```

3. **Access Web UI**:
   Open [http://localhost:3000](http://localhost:3000)

4. **Interact via Console**:
   To attach to the running container's console for CLI chat:
   ```bash
   docker attach gitubot
   ```
   *(Press `Ctrl+P`, `Ctrl+Q` to detach without stopping)*

## Persistence

The `docker-compose.yml` is configured to persist:
- `config.json`: Your bot configuration.
- `.env`: Your API keys and secrets.
- `.wwebjs_auth`: Your WhatsApp session (so you don't have to scan QR code every time).

## Troubleshooting

- **"Command not found"**: Ensure Docker Desktop is running. You may need to restart your terminal after installation.
- **WhatsApp**: Check logs immediately (`docker compose logs -f`) to scan the QR code.
