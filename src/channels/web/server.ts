import { ChannelAdapter, Message } from '../../core/types';
import express from 'express';
import { Server } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { AuthManager } from '../../core/auth';
import multer from 'multer';
import { sttService } from '../../core/stt';
import { ttsService } from '../../core/tts';

export class WebChannel implements ChannelAdapter {
  name = 'web';
  private app: express.Express;
  private server: Server;
  private io: SocketIOServer;
  private handler: ((msg: Message) => void) | null = null;
  private isStarted = false;
  private port = 3000;
  private startTime: number;
  private auth: AuthManager;

  constructor(port: number = 3000) {
    this.port = port;
    this.app = express();
    this.server = new Server(this.app);
    this.io = new SocketIOServer(this.server);
    this.startTime = Date.now();
    this.auth = new AuthManager();

    // Serve static frontend files
    // Serve static frontend files
    this.app.use(express.static(path.join(__dirname, 'public')));
    this.app.use(express.json());

    // Login Endpoint
    this.app.post('/auth/login', (req, res) => {
      const { username, password } = req.body;
      const user = this.auth.login(username, password);
      if (user) {
        // Simple token for MVP: just the username
        // In prod, use JWT
        res.json({ token: user.username });
      } else {
        res.status(401).json({ error: 'Invalid credentials' });
      }
    });

    // Voice Note Upload Endpoint
    const upload = multer({ storage: multer.memoryStorage() });

    this.app.post('/voice', upload.single('audio'), async (req, res) => {
      // Basic check: Authenticated via header?
      // For simplicity, we'll skip complex auth for this MVP endpoint or pass socketId
      // In real app, use session cookie or JWT

      if (!req.file) {
        return res.status(400).json({ error: 'No audio file uploaded' });
      }

      const socketId = req.body.socketId;
      if (!socketId || !this.auth.isAuthenticated(socketId)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      try {
        console.log(`[WebChannel] Received voice note from ${socketId} (${req.file.size} bytes)`);

        // 1. Transcribe (STT) using Deepgram
        const transcription = await sttService.transcribe(req.file.buffer, req.file.mimetype);

        if (!transcription) {
          return res.json({ status: 'ok', transcription: '', audio: null });
        }

        // 2. Process with Agent
        // We need to wait for the agent's text response to convert it to speech.
        // This is tricky because the agent is async/streaming.
        // For this MVP, we'll implement a "Synchronous" wait helper or listen for the next message.

        // Simpler approach: We'll inject the message, let the agent respond via socket as usual (text),
        // BUT we also want to capture that text to generate speech.

        let agentResponseText = '';

        // Create a temporary promise to capture the next response for this user
        const responsePromise = new Promise<string>((resolve) => {
          const tempHandler = (text: string) => {
            agentResponseText += text; // Collect chunks if streaming, but here we usually get full msg for now
            // In a real stream, we'd need to wait for 'done'. 
            // For now, let's assume the agent sends one main message block or we wait a bit.

            // Hack: Wait a short bit to see if more comes, then resolve? 
            // Or just resolve on first chunk? 
            // Let's rely on the fact that existing logic sends full text in 'message' event usually, 
            // or chunks in 'stream_chunk'.

            // If we are intercepting the "Response", we need a way to know it's done.
            // Since we don't have a robust event bus for "Request->Response" mapping yet,
            // We will use a simplified flow:
            // 1. We won't block the HTTP request for the agent functionality across the board.
            // 2. We will just return the Transcription to the UI immediately.
            // 3. The UI will send the Transcription as a Text Message via Socket.
            // 4. The Agent replies via Socket.
            // 5. The UI realizes "I entered this via Voice", so it wants the reply to be spoken.
            // 6. The UI sends the Agent's Reply Text BACK to a /tts endpoint to get audio.

            // WAIT! That adds latency (Round trip).
            // Better: We handle it server side if possible.

            resolve(text);
          };
          // This is complex to hook into the current event-driven architecture without refactoring AgentRunner.
        });

        // REVISED PLAN FOR MVP:
        // 1. /voice endpoint returns Transcription.
        // 2. Client puts Transcription into Chat Input automatically.
        // 3. Client sends message via Socket (as if typed).
        // 4. Agent replies via Socket.
        // 5. Client sees "Voice Mode" is on.
        // 6. Client takes Bot Message, calls POST /tts with text.
        // 7. Client plays returned Audio.

        // This decouples STT and TTS and avoids complex server-side state waiting.

        res.json({ status: 'ok', transcription });

      } catch (e: any) {
        console.error('[WebChannel] Voice processing error:', e);
        res.status(500).json({ error: e.message });
      }
    });

    // TTS Endpoint
    this.app.post('/tts', express.json(), async (req, res) => {
      const { text } = req.body;
      if (!text) return res.status(400).json({ error: 'No text provided' });

      try {
        const audioBuffer = await ttsService.generate(text);
        res.set('Content-Type', 'audio/mpeg');
        res.send(audioBuffer);
      } catch (e: any) {
        console.error('[WebChannel] TTS error:', e);
        res.status(500).json({ error: e.message });
      }
    });

    // ===== DASHBOARD API =====

    this.app.get('/api/stats', (req, res) => {
      try {
        // Read data files
        const projectsData = this.readJsonFile('projects_data.json');
        const swarmData = this.readJsonFile('swarm_data.json');
        const businessData = this.readJsonFile('business_data.json');

        const activeProjects = projectsData.projects?.filter((p: any) => p.status === 'active').length || 0;
        const activeAgents = swarmData.agents?.length || 0;
        const tasksDone = projectsData.tasks?.filter((t: any) => t.status === 'done').length || 0;

        let income = 0;
        if (businessData.finance) {
          income = businessData.finance
            .filter((f: any) => f.type === 'income')
            .reduce((sum: number, f: any) => sum + (f.amount || 0), 0);
        }

        res.json({
          activeProjects,
          activeAgents,
          tasksDone,
          totalIncome: income
        });
      } catch (e: any) {
        console.error('[WebChannel] Stats error:', e);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/agents', (req, res) => {
      try {
        const data = this.readJsonFile('swarm_data.json');
        res.json({ agents: data.agents || [] });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/projects', (req, res) => {
      try {
        const data = this.readJsonFile('projects_data.json');
        // Calculate progress for each project
        const projects = (data.projects || []).map((p: any) => {
          const pTasks = (data.tasks || []).filter((t: any) => t.projectId === p.id);
          const total = pTasks.length;
          const done = pTasks.filter((t: any) => t.status === 'done').length;
          const progress = total > 0 ? Math.round((done / total) * 100) : 0;
          return { ...p, progress, taskCount: total, doneCount: done };
        });
        res.json({ projects });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    // Heartbeat Endpoint
    this.app.get('/heartbeat', (req, res) => {
      const uptime = Math.floor((Date.now() - this.startTime) / 1000);
      res.json({
        status: 'ok',
        uptime: `${uptime}s`,
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        connections: this.io.engine.clientsCount
      });
    });

    this.io.on('connection', (socket) => {
      console.log('[WebChannel] New client connected:', socket.id);

      // Handle token auth from handshake
      const token = socket.handshake.auth.token;
      if (token) {
        // In our simple MVP, token is just the username
        const user = this.auth.getUser(token);
        if (user) {
          this.auth.createSession(socket.id, user.id);
          socket.join(user.id);
          socket.data.userId = user.id;
          console.log(`[WebChannel] User ${user.username} authenticated via token on socket ${socket.id}`);
          socket.emit('login_success', { username: user.username, socketId: socket.id });
        }
      }

      socket.on('login', (data: any) => {
        const { username, password } = data;
        const user = this.auth.login(username, password);
        if (user) {
          this.auth.createSession(socket.id, user.id);
          socket.join(user.id);
          socket.data.userId = user.id;
          socket.emit('login_success', { username: user.username, socketId: socket.id });
          console.log(`[WebChannel] User ${username} logged in on socket ${socket.id}`);
        } else {
          socket.emit('login_failed', { message: 'Invalid credentials' });
        }
      });

      socket.on('get_settings', () => {
        if (!this.auth.isAuthenticated(socket.id)) {
          socket.emit('error', 'Authentication required.');
          return;
        }

        try {
          let config: any = {};
          if (fs.existsSync('config.json')) {
            config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
          }

          // Return settings with secrets masked
          const settings = {
            name: config.name || 'Gitubot',
            model: config.model || 'OpenRouter',
            aiModel: config.aiModel || '', // Specific Model ID
            channels: config.channels || [],
            telegramToken: process.env.TELEGRAM_BOT_TOKEN ? '********' : '',
            discordToken: process.env.DISCORD_BOT_TOKEN ? '********' : '',
            slackBotToken: process.env.SLACK_BOT_TOKEN ? '********' : '',
            slackAppToken: process.env.SLACK_APP_TOKEN ? '********' : '',
            openrouterKey: process.env.OPENROUTER_API_KEY ? '********' : '',
            nvidiaKey: process.env.NVIDIA_API_KEY ? '********' : '',
            openaiKey: process.env.OPENAI_API_KEY ? '********' : '',
            anthropicKey: process.env.ANTHROPIC_API_KEY ? '********' : '',
            geminiKey: process.env.GEMINI_API_KEY ? '********' : '',
            elevenLabsKey: process.env.ELEVENLABS_API_KEY ? '********' : '',
            elevenLabsVoice: process.env.ELEVENLABS_VOICE_ID || '',
            deepgramKey: process.env.DEEPGRAM_API_KEY ? '********' : '',
            filesystemMode: config.filesystemMode || 'project'
          };

          socket.emit('settings_data', settings);
        } catch (e: any) {
          socket.emit('error', 'Failed to load settings: ' + e.message);
        }
      });

      socket.on('save_settings', (data: any) => {
        if (!this.auth.isAuthenticated(socket.id)) {
          socket.emit('error', 'Authentication required.');
          return;
        }

        try {
          console.log('[WebChannel] save_settings received:', JSON.stringify(data, null, 2));

          // 1. Update config.json
          let config: any = {};
          if (fs.existsSync('config.json')) {
            config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
          }
          config.name = data.name;
          config.model = data.model;
          config.aiModel = data.aiModel; // Save specific model ID
          config.filesystemMode = data.filesystemMode;
          // Only update channels if provided in data
          if (data.channels) config.channels = data.channels;

          // Update Filesystem MCP args based on mode
          if (config.mcpServers && config.mcpServers.filesystem) {
            const fsArgs = config.mcpServers.filesystem.args;
            // Ensure we replace the last arg which is the path
            if (config.filesystemMode === 'full') {
              fsArgs[fsArgs.length - 1] = 'c:/';
            } else {
              fsArgs[fsArgs.length - 1] = './';
            }
          }

          fs.writeFileSync('config.json', JSON.stringify(config, null, 2));

          // 2. Update .env
          let envContent = '';
          if (fs.existsSync('.env')) {
            envContent = fs.readFileSync('.env', 'utf-8');
          }

          const updateEnv = (key: string, value: string) => {
            if (!value || value === '********') {
              console.log(`[WebChannel] Skipping env update for ${key} (value: ${value})`);
              return;
            }
            const regex = new RegExp(`^${key}=.*`, 'm');
            if (regex.test(envContent)) {
              console.log(`[WebChannel] Updating existing env var: ${key}`);
              envContent = envContent.replace(regex, `${key}=${value}`);
            } else {
              console.log(`[WebChannel] Appending new env var: ${key}`);
              envContent += `\n${key}=${value}`;
            }

            // Also update process.env immediately so runtime picks it up
            process.env[key] = value;
          };

          updateEnv('TELEGRAM_BOT_TOKEN', data.telegramToken);
          updateEnv('DISCORD_BOT_TOKEN', data.discordToken);
          updateEnv('SLACK_BOT_TOKEN', data.slackBotToken);
          updateEnv('SLACK_APP_TOKEN', data.slackAppToken);
          updateEnv('OPENROUTER_API_KEY', data.openrouterKey);
          updateEnv('NVIDIA_API_KEY', data.nvidiaKey);
          updateEnv('OPENAI_API_KEY', data.openaiKey);
          updateEnv('ANTHROPIC_API_KEY', data.anthropicKey);
          updateEnv('GEMINI_API_KEY', data.geminiKey);
          updateEnv('ELEVENLABS_API_KEY', data.elevenLabsKey);
          updateEnv('ELEVENLABS_VOICE_ID', data.elevenLabsVoice);
          updateEnv('DEEPGRAM_API_KEY', data.deepgramKey);

          fs.writeFileSync('.env', envContent.trim());

          socket.emit('settings_saved', { message: 'Settings saved successfully.' });
        } catch (e: any) {
          socket.emit('error', 'Failed to save settings: ' + e.message);
        }
      });

      socket.on('message', (text: string) => {
        if (!this.auth.isAuthenticated(socket.id)) {
          socket.emit('error', 'Authentication required. Please log in.');
          return;
        }

        if (this.handler) {
          const user = this.auth.getUserBySession(socket.id);
          const stableUserId = user?.id || socket.data.userId || socket.id;
          const msg: Message = {
            id: uuidv4(),
            channel: 'web',
            senderId: stableUserId,
            content: text,
            timestamp: Date.now(),
            metadata: {
              username: user ? user.username : 'Anonymous'
            }
          };
          this.handler(msg);
        }
      });

      socket.on('disconnect', () => {
        console.log('[WebChannel] Client disconnected:', socket.id);
      });
    });
  }

  start() {
    if (!this.isStarted) {
      this.server.on('error', (e: any) => {
        if (e.code === 'EADDRINUSE') {
          console.log(`[WebChannel] Port ${this.port} in use, trying ${this.port + 1}...`);
          this.port++;
          this.server.listen(this.port);
        } else {
          console.error('[WebChannel] Server error:', e);
        }
      });

      this.server.listen(this.port, () => {
        console.log(`[WebChannel] Server running at http://localhost:${this.port}`);
      });
      this.isStarted = true;
    }
  }

  send(userId: string, text: string) {
    // userId maps to a socket.io room joined by the authenticated user
    this.io.to(userId).emit('message', text);
  }

  // New method for streaming
  sendStream(userId: string, chunk: string) {
    this.io.to(userId).emit('stream_chunk', chunk);
  }

  onMessage(handler: (msg: Message) => void) {
    this.handler = handler;
  }

  private readJsonFile(filename: string): any {
    const filePath = path.join(process.cwd(), filename);
    if (fs.existsSync(filePath)) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        return {};
      }
    }
    return {};
  }
}
