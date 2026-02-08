import fs from 'fs';
import path from 'path';

export interface User {
    id: string;
    username: string;
    passwordHash: string; // In production, use real hashing (bcrypt/argon2). Here simple text for demo.
}

export class AuthManager {
    private users: Map<string, User> = new Map();
    private filePath: string;
    private sessions: Map<string, string> = new Map(); // sessionId -> userId

    constructor() {
        this.filePath = path.join(process.cwd(), 'users.json');
        this.load();

        // Create default admin if empty
        if (this.users.size === 0) {
            this.register('admin', 'admin');
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
            fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error('[AuthManager] Failed to save users:', e);
        }
    }

    register(username: string, password: string): boolean {
        if (this.users.has(username)) return false;
        const user: User = {
            id: Math.random().toString(36).substr(2, 9),
            username,
            passwordHash: password // TODO: Hash this!
        };
        this.users.set(username, user);
        this.save();
        return true;
    }

    login(username: string, password: string): User | null {
        const user = this.users.get(username);
        if (user && user.passwordHash === password) {
            return user;
        }
        return null;
    }

    getUser(username: string): User | undefined {
        return this.users.get(username);
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
