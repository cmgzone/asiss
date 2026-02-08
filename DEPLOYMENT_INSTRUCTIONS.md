# GitHub Deployment Successful!

I have successfully initialized the Git repository and pushed your code to:
**https://github.com/cmgzone/asiss**

## Next Steps for Coolify Deployment:

1.  **Add Repository:** In your Coolify dashboard, add a new project/resource using this GitHub repository URL.
2.  **Configuration:** Coolify should automatically detect the `Dockerfile`.
    *   **Port:** Ensure the exposed port is set to **3000** (or 3001 if 3000 is taken).
3.  **Environment Variables:** You MUST manually add your API keys in Coolify's "Environment Variables" section, as `.env` files are excluded from Git for security:
    *   `OPENROUTER_API_KEY`
    *   `NVIDIA_API_KEY`
    *   `TELEGRAM_BOT_TOKEN`
    *   Any other keys from your local `.env`.

The code includes the **Task Persistence** system and **Elevated Mode** (set to 'full' by default). You're ready to go!
