/**
 * PM2 Ecosystem Configuration for Gitu Assistant
 * 
 * This enables 24/7 operation with:
 * - Automatic restarts on crash
 * - Memory limit monitoring
 * - Log rotation
 * - Watch mode for development
 * 
 * Usage:
 *   Production: pm2 start ecosystem.config.js
 *   Development: pm2 start ecosystem.config.js --env development
 *   Stop: pm2 stop gitu
 *   Restart: pm2 restart gitu
 *   Logs: pm2 logs gitu
 *   Status: pm2 status
 */

module.exports = {
    apps: [{
        name: 'gitu',
        script: 'dist/index.js',

        // Restart Policies
        autorestart: true,
        max_restarts: 10,
        min_uptime: '10s',
        restart_delay: 5000,

        // Memory Management
        max_memory_restart: '500M',

        // Logging
        log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
        error_file: './logs/gitu-error.log',
        out_file: './logs/gitu-out.log',
        merge_logs: true,

        // Environment
        env: {
            NODE_ENV: 'production',
        },
        env_development: {
            NODE_ENV: 'development',
            watch: true,
            watch_delay: 1000,
            ignore_watch: ['node_modules', 'logs', '*.json', '*.md', 'artifacts']
        },

        // Graceful Shutdown
        kill_timeout: 5000,
        wait_ready: true,
        listen_timeout: 10000,

        // Cron-like restart (optional: restart daily at 4am for memory cleanup)
        cron_restart: '0 4 * * *'
    }]
};
