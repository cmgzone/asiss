import fs from 'fs';
import path from 'path';

/**
 * Do Not Disturb Manager
 * 
 * Manages quiet hours for the assistant. During DND:
 * - Low priority notifications are queued
 * - High priority alerts still go through
 * - Scheduled jobs can be deferred
 */

export interface DNDConfig {
    enabled: boolean;
    quietHoursStart: number;  // 0-23 (e.g., 22 for 10 PM)
    quietHoursEnd: number;    // 0-23 (e.g., 8 for 8 AM)
    timezone?: string;        // IANA timezone (e.g., 'America/New_York')
    allowUrgent: boolean;     // Allow urgent/high-priority through
}

export interface QueuedNotification {
    id: string;
    sessionId: string;
    message: string;
    priority: 'low' | 'normal' | 'high' | 'urgent';
    createdAt: number;
    scheduledFor?: number;
}

export class DNDManager {
    private configPath: string;
    private queuePath: string;
    private config: DNDConfig;
    private queue: QueuedNotification[] = [];

    constructor() {
        this.configPath = path.join(process.cwd(), 'config.json');
        this.queuePath = path.join(process.cwd(), 'notification_queue.json');
        this.config = {
            enabled: false,
            quietHoursStart: 22,
            quietHoursEnd: 8,
            allowUrgent: true
        };
        this.load();
    }

    private load() {
        // Load DND config from main config
        if (fs.existsSync(this.configPath)) {
            try {
                const config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
                if (config.dnd && typeof config.dnd === 'object') {
                    this.config = { ...this.config, ...config.dnd };
                }
            } catch {
                // Use defaults
            }
        }

        // Load queued notifications
        if (fs.existsSync(this.queuePath)) {
            try {
                this.queue = JSON.parse(fs.readFileSync(this.queuePath, 'utf-8')) || [];
            } catch {
                this.queue = [];
            }
        }
    }

    private saveQueue() {
        try {
            fs.writeFileSync(this.queuePath, JSON.stringify(this.queue, null, 2));
        } catch {
            console.error('[DND] Failed to save notification queue');
        }
    }

    /**
     * Get current hour in configured timezone (or local)
     */
    private getCurrentHour(): number {
        const now = new Date();
        if (this.config.timezone) {
            try {
                const formatter = new Intl.DateTimeFormat('en-US', {
                    hour: 'numeric',
                    hour12: false,
                    timeZone: this.config.timezone
                });
                return parseInt(formatter.format(now), 10);
            } catch {
                return now.getHours();
            }
        }
        return now.getHours();
    }

    /**
     * Check if currently in quiet hours
     */
    public isQuietHours(): boolean {
        if (!this.config.enabled) return false;

        const currentHour = this.getCurrentHour();
        const { quietHoursStart, quietHoursEnd } = this.config;

        // Handle overnight quiet hours (e.g., 22:00 - 08:00)
        if (quietHoursStart > quietHoursEnd) {
            return currentHour >= quietHoursStart || currentHour < quietHoursEnd;
        }

        // Handle same-day quiet hours (e.g., 14:00 - 16:00)
        return currentHour >= quietHoursStart && currentHour < quietHoursEnd;
    }

    /**
     * Check if a notification should go through now
     */
    public shouldNotify(priority: 'low' | 'normal' | 'high' | 'urgent' = 'normal'): boolean {
        if (!this.isQuietHours()) return true;
        if (this.config.allowUrgent && (priority === 'urgent' || priority === 'high')) return true;
        return false;
    }

    /**
     * Queue a notification for later
     */
    public queueNotification(
        sessionId: string,
        message: string,
        priority: 'low' | 'normal' | 'high' | 'urgent' = 'normal'
    ): QueuedNotification {
        const notification: QueuedNotification = {
            id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            sessionId,
            message,
            priority,
            createdAt: Date.now()
        };
        this.queue.push(notification);
        this.saveQueue();
        console.log(`[DND] Queued notification: ${notification.id}`);
        return notification;
    }

    /**
     * Get and clear all pending notifications (call when quiet hours end)
     */
    public flushQueue(sessionId?: string): QueuedNotification[] {
        const matching = sessionId
            ? this.queue.filter(n => n.sessionId === sessionId)
            : [...this.queue];

        if (sessionId) {
            this.queue = this.queue.filter(n => n.sessionId !== sessionId);
        } else {
            this.queue = [];
        }

        this.saveQueue();
        return matching;
    }

    /**
     * Get pending notification count
     */
    public getPendingCount(sessionId?: string): number {
        if (sessionId) {
            return this.queue.filter(n => n.sessionId === sessionId).length;
        }
        return this.queue.length;
    }

    /**
     * Get current DND status for display
     */
    public getStatus(): { inQuietHours: boolean; config: DNDConfig; pendingCount: number } {
        return {
            inQuietHours: this.isQuietHours(),
            config: this.config,
            pendingCount: this.queue.length
        };
    }

    /**
     * Calculate next notification window time
     */
    public getNextNotificationTime(): Date {
        if (!this.isQuietHours()) return new Date();

        const now = new Date();
        const result = new Date(now);
        result.setHours(this.config.quietHoursEnd, 0, 0, 0);

        // If we're past the end time today, it means quiet hours span midnight
        // and we need tomorrow's end time
        if (result <= now) {
            result.setDate(result.getDate() + 1);
        }

        return result;
    }
}

export const dndManager = new DNDManager();
