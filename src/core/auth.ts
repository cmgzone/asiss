import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface User {
    id: string;
    username: string;
    passwordHash: string; // In production, use real hashing (bcrypt/argon2). Here simple text for demo.
}

// API tokens live in memory only (restart invalidates them). They still expire so
// long-running processes do not accumulate forever-valid credentials.
const TOKEN_TTL_MS = Number(process.env.GITU_TOKEN_TTL_MS) > 0
    ? Number(process.env.GITU_TOKEN_TTL_MS)
    : 30 * 24 * 60 * 60 * 1000; // 30 days

export class AuthManager {
    private users: Map<string, User> = new Map();
    private filePath: string;
    private sessions: Map<string, string> = new Map(); // sessionId -> userId
    private tokens: Map<string, { userId: string; expiresAt: number }> = new Map(); // authToken -> { userId, expiresAt }
    private tokenCreations = 0;

    constructor() {
        this.filePath = path.join(process.cwd(), 'users.json');
        this.load();

        // Create default admin if empty
        if (this.users.size === 0) {
            const username = process.env.GITU_ADMIN_USERNAME || 'admin';
            const configuredPassword = process.env.GITU_ADMIN_PASSWORD;
            const password = configuredPassword || crypto.randomBytes(18).toString('base64url');
            this.register(username, password);
            if (!configuredPassword) {
                console.warn(`[AuthManager] Created initial user '${username}'. One-time password: ${password}`);
                console.warn('[AuthManager] Set GITU_ADMIN_PASSWORD before first launch to choose the bootstrap password.');
            }
        }
    }

    private load() {
        if (fs.existsSync(this.filePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                data.forEach((u: User) => this.users.set(u.username, u));
            } catch (e) {
                console.error('[AuthManager] Failed to load users:', e);
            }
        }
    }

    private save() {
        try {
            const data = Array.from(this.users.values());
            const tmpPath = `${this.filePath}.tmp`;
            fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
            fs.renameSync(tmpPath, this.filePath);
        } catch (e) {
            console.error('[AuthManager] Failed to save users:', e);
        }
    }

    private hashPassword(password: string): string {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(password, salt, 64).toString('hex');
        return `scrypt:${salt}:${hash}`;
    }

    private verifyPassword(password: string, stored: string): boolean {
        if (!stored.startsWith('scrypt:')) {
            // Backward compatibility for existing demo/plaintext users.
            const a = Buffer.from(stored);
            const b = Buffer.from(password);
            return a.length === b.length && crypto.timingSafeEqual(a, b);
        }

        const [, salt, expectedHex] = stored.split(':');
        if (!salt || !expectedHex) return false;

        const actual = crypto.scryptSync(password, salt, 64);
        const expected = Buffer.from(expectedHex, 'hex');
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    }

    register(username: string, password: string): boolean {
        if (this.users.has(username)) return false;
        const user: User = {
            id: Math.random().toString(36).substr(2, 9),
            username,
            passwordHash: this.hashPassword(password)
        };
        this.users.set(username, user);
        this.save();
        return true;
    }

    login(username: string, password: string): User | null {
        const user = this.users.get(username);
        if (!user || !this.verifyPassword(password, user.passwordHash)) {
            return null;
        }

        if (!user.passwordHash.startsWith('scrypt:')) {
            user.passwordHash = this.hashPassword(password);
            this.save();
        }
        return user;
    }

    getUser(username: string): User | undefined {
        return this.users.get(username);
    }

    createAuthToken(userId: string): string {
        // Periodically prune expired tokens so the map stays bounded.
        this.tokenCreations += 1;
        if (this.tokenCreations % 200 === 0) {
            const now = Date.now();
            for (const [key, value] of this.tokens) {
                if (value.expiresAt <= now) this.tokens.delete(key);
            }
        }
        const token = crypto.randomBytes(32).toString('base64url');
        this.tokens.set(token, { userId, expiresAt: Date.now() + TOKEN_TTL_MS });
        return token;
    }

    getUserByToken(token: string): User | undefined {
        const entry = this.tokens.get(token);
        if (!entry) return undefined;
        if (entry.expiresAt <= Date.now()) {
            this.tokens.delete(token);
            return undefined;
        }
        return Array.from(this.users.values()).find(u => u.id === entry.userId);
    }

    revokeToken(token: string) {
        this.tokens.delete(token);
    }

    endSession(socketId: string) {
        this.sessions.delete(socketId);
    }

    createSession(socketId: string, userId: string) {
        this.sessions.set(socketId, userId);
    }

    getUserBySession(socketId: string): User | undefined {
        const userId = this.sessions.get(socketId);
        if (!userId) return undefined;
        return Array.from(this.users.values()).find(u => u.id === userId);
    }

    isAuthenticated(socketId: string): boolean {
        return this.sessions.has(socketId);
    }
}
