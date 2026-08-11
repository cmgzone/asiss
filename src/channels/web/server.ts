import { ChannelAdapter, Message, StreamEventPayload } from '../../core/types';
import express from 'express';
import { Server } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { AuthManager } from '../../core/auth';
import multer from 'multer';
import { sttService } from '../../core/stt';
import { ttsService } from '../../core/tts';
import { modelManager, resolveModelApiKey, isProviderKeyValid } from '../../core/model-manager';
import { ModelRegistry } from '../../core/models';
import { OpenCodeProvider } from '../../agents/opencode-provider';
import { OpenRouterProvider } from '../../agents/openrouter-provider';
import { NvidiaProvider } from '../../agents/nvidia-provider';
import { GenericOpenAIProvider } from '../../agents/openai-provider';
import { whatsappEvents, WhatsAppStatusPayload } from '../../core/whatsapp-events';
import QRCode from 'qrcode';
import { MediaPayload } from '../../core/types';
import { analyticsTracker } from '../../core/analytics-tracker';
import { agentSwarm } from '../../core/agent-swarm';
import { costTracker } from '../../core/cost-tracker';
import { proactiveEngine } from '../../core/proactive-engine';
import { stripShellStreamMarker } from '../../core/stream-markers';
import { learnedSkillsManager } from '../../core/learned-skills';
import { backgroundWorker } from '../../core/background-worker';
import crypto from 'crypto';
import { workspaceManager } from '../../core/workspace-manager';
import { conversationManager } from '../../core/conversation-manager';
import { modelResilienceManager } from '../../core/resilient-model';
import { portableSkillsManager } from '../../core/portable-skills';
import { trajectoryStore } from '../../core/trajectory-store';
import { checkpointManager } from '../../core/checkpoint-manager';
import { hookManager } from '../../core/hooks';
import { executionBackendManager } from '../../core/execution-backend';
import { attachmentStore } from '../../core/attachment-store';

interface ApiCapture {
  messages: string[];
  chunks: string[];
  events: StreamEventPayload[];
  media: MediaPayload[];
  onEvent?: (event: StreamEventPayload) => void;
}

export class WebChannel implements ChannelAdapter {
  name = 'web';
  private app: express.Express;
  private server: Server;
  private io: SocketIOServer;
  private handler: ((msg: Message) => void | Promise<void>) | null = null;
  private apiCaptures = new Map<string, ApiCapture>();
  private isStarted = false;
  private port = 3000;
  private startTime: number;
  private auth: AuthManager;
  private lastWhatsAppQr: string | null = null;
  private lastWhatsAppStatus: WhatsAppStatusPayload = { status: 'idle' };

  constructor(port: number = 3000) {
    this.port = port;
    this.app = express();
    this.server = new Server(this.app);
    this.io = new SocketIOServer(this.server);
    this.startTime = Date.now();
    this.auth = new AuthManager();

    const getBearerToken = (req: express.Request) => {
      const header = req.get('authorization') || '';
      const match = /^Bearer\s+(.+)$/i.exec(header);
      return match ? match[1].trim() : '';
    };

    const requireApiAuth: express.RequestHandler = (req, res, next) => {
      const token = getBearerToken(req);
      const user = token ? this.auth.getUserByToken(token) : undefined;
      if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      (req as any).user = user;
      next();
    };

    const requireOpenAiAuth: express.RequestHandler = (req, res, next) => {
      const token = getBearerToken(req);
      const configuredKey = String(process.env.GITU_API_KEY || '').trim();
      const user = token ? this.auth.getUserByToken(token) : undefined;
      if ((!configuredKey || token !== configuredKey) && !user) {
        res.status(401).json({ error: { message: 'A valid GITU_API_KEY or web auth token is required.', type: 'authentication_error' } });
        return;
      }
      (req as any).user = user || { id: 'api', username: 'api' };
      next();
    };

    const resolveLearningSessionId = (req: express.Request) => {
      const user = (req as any).user;
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
      const project = projectId ? this.resolveProjectContext(projectId) : undefined;
      const scopedUserId = project?.id ? `${user.id}:project:${project.id}` : user.id;
      const digest = crypto.createHash('sha256').update(`web:${scopedUserId}`).digest('hex').slice(0, 24);
      return { sessionId: `session_${digest}`, projectId: project?.id || '' };
    };

    // Serve static frontend files (robust path resolution for ts-node/dist/docker)
    const resolvePublicDir = () => {
      const candidates = [
        path.join(__dirname, 'public'),
        path.join(process.cwd(), 'src', 'channels', 'web', 'public'),
        path.join(process.cwd(), 'dist', 'channels', 'web', 'public'),
        path.join(process.cwd(), 'channels', 'web', 'public')
      ];
      for (const candidate of candidates) {
        try {
          if (fs.existsSync(candidate)) return candidate;
        } catch {
          // ignore
        }
      }
      return '';
    };

    const publicDir = resolvePublicDir();
    this.app.get('/vendor/marked.js', (_req, res) => {
      res.sendFile(path.join(process.cwd(), 'node_modules', 'marked', 'lib', 'marked.umd.js'));
    });
    if (publicDir) {
      this.app.get('/', (_req, res) => {
        const indexPath = path.join(publicDir, 'index.html');
        const html = fs.readFileSync(indexPath, 'utf-8')
          .replace('<option>mock</option>', '')
          .replace(":/nvidia/i.test(providerName)?'NVIDIA':'mock'", ":/nvidia/i.test(providerName)?'NVIDIA':'OpenRouter'")
          .replace('</head>', '<link rel="stylesheet" href="/layout-fix.css"><link rel="stylesheet" href="/chat-progress.css"></head>')
          .replace('</body>', '<script src="/chat-progress.js"></script></body>');
        res.type('html').send(html);
      });
      this.app.use(express.static(publicDir));
    } else {
      console.warn('[WebChannel] Public UI directory not found; / will return 404.');
    }
    // Artifacts are now served through an authenticated route so generated files
    // are not world-readable on the network. express.json() caps the body size;
    // the /v1/chat/completions image attachments (up to 4 x ~11 MB data URLs)
    // are the largest legitimate payloads.
    this.app.get('/api/artifacts/*splat', requireApiAuth, (req, res) => {
      try {
        const artifactsRoot = path.resolve(process.cwd(), 'artifacts');
        const rel = Array.isArray(req.params.splat)
          ? req.params.splat.join('/')
          : String(req.params.splat || '');
        const filePath = path.resolve(artifactsRoot, rel);
        if (filePath !== artifactsRoot && !filePath.startsWith(artifactsRoot + path.sep)) {
          return res.status(403).json({ error: 'Forbidden' });
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          return res.status(404).json({ error: 'Not found' });
        }
        res.sendFile(filePath);
      } catch (e: any) {
        res.status(500).json({ error: e?.message || 'Failed to serve artifact.' });
      }
    });
    this.app.use(express.json({ limit: '50mb' }));

    this.app.get('/v1/models', requireOpenAiAuth, (_req, res) => {
      const active = ModelRegistry.getCurrentModel();
      res.json({
        object: 'list',
        data: [{ id: active?.id || 'gitu-agent', object: 'model', created: 0, owned_by: 'gitu' }]
      });
    });

    this.app.post('/v1/chat/completions', requireOpenAiAuth, async (req, res) => {
      const wantsStream = req.body?.stream === true;
      const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
      const apiAttachments = messages.flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
        .filter((part: any) => part?.type === 'image_url' && typeof part?.image_url?.url === 'string')
        .map((part: any) => String(part.image_url.url))
        .filter((url: string) => /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(url) && url.length <= 11_000_000)
        .slice(0, 4)
        .map((dataUrl: string) => ({ type: 'image', mimeType: /^data:([^;]+)/i.exec(dataUrl)?.[1] || 'image/png', dataUrl }));
      const content = messages
        .map((item: any) => {
          const value = typeof item?.content === 'string'
            ? item.content
            : Array.isArray(item?.content)
              ? item.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n')
              : '';
          return value ? `${String(item.role || 'user')}: ${value}` : '';
        })
        .filter(Boolean)
        .join('\n\n')
        .trim();
      if (!content) {
        res.status(400).json({ error: { message: 'messages must contain at least one text message.', type: 'invalid_request_error' } });
        return;
      }
      try {
        if (wantsStream) {
          res.status(200);
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.flushHeaders();
          const created = Math.floor(Date.now() / 1000);
          const model = String(req.body?.model || ModelRegistry.getCurrentModel()?.id || 'gitu-agent');
        const result = await this.runApiRequest(content, {
          source: 'api',
          userId: String((req as any).user?.id || 'api'),
          metadata: { model, projectId: req.body?.projectId, conversationId: req.body?.conversationId, attachments: apiAttachments }
        }, event => {
            if (event.type !== 'assistant_delta' || !event.text) return;
            const chunk = {
              id: 'chatcmpl-gitu-stream', object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }]
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          });
          if (!result.events.some(event => event.type === 'assistant_delta') && result.text) {
            res.write(`data: ${JSON.stringify({
              id: `chatcmpl-${result.trajectoryId}`, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }]
            })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({
            id: `chatcmpl-${result.trajectoryId}`, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        const result = await this.runApiRequest(content, {
          source: 'api',
          userId: String((req as any).user?.id || 'api'),
          metadata: { model: req.body?.model, projectId: req.body?.projectId, conversationId: req.body?.conversationId, attachments: apiAttachments }
        });
        res.json({
          id: `chatcmpl-${result.trajectoryId}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: String(req.body?.model || ModelRegistry.getCurrentModel()?.id || 'gitu-agent'),
          choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          gitu: { trajectory_id: result.trajectoryId, event_count: result.events.length }
        });
      } catch (error: any) {
        if (res.headersSent) {
          // Headers are already streaming; cannot send a JSON error anymore.
          try { res.end('data: [DONE]\n\n'); } catch { /* client already gone */ }
          return;
        }
        res.status(500).json({ error: { message: error?.message || 'Agent request failed.', type: 'agent_error' } });
      }
    });

    this.app.post('/api/batch/run', requireOpenAiAuth, async (req, res) => {
      const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 25) : [];
      if (!items.length) {
        res.status(400).json({ error: 'items must be a non-empty array (maximum 25).' });
        return;
      }
      const userId = String((req as any).user?.id || 'batch');
      const concurrency = Math.max(1, Math.min(Number(req.body?.concurrency) || 3, 6));
      const results: any[] = new Array(items.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < items.length) {
          const index = cursor++;
          const item = items[index];
          const content = typeof item === 'string' ? item : String(item?.content || '');
          try {
            const output = await this.runApiRequest(content, {
              source: 'batch', userId, metadata: { index, ...(typeof item === 'object' ? item.metadata : {}) }
            });
            results[index] = { index, status: 'completed', output: output.text, trajectoryId: output.trajectoryId };
          } catch (error: any) {
            results[index] = { index, status: 'failed', error: error?.message || 'Batch item failed.' };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
      res.json({ object: 'gitu.batch', count: results.length, results });
    });

    this.app.get('/api/trajectories', requireApiAuth, (req, res) => {
      res.json({ status: trajectoryStore.status(), trajectories: trajectoryStore.list(Number(req.query.limit) || 50) });
    });

    this.app.get('/api/trajectories/:id', requireApiAuth, (req, res) => {
      const record = trajectoryStore.get(String(req.params.id || ''));
      if (!record) return res.status(404).json({ error: 'Trajectory not found.' });
      res.json(record);
    });

    this.app.get('/api/runtime/status', requireApiAuth, (_req, res) => {
      res.json({
        models: modelResilienceManager.list(),
        checkpoints: checkpointManager.status(),
        trajectories: trajectoryStore.status(),
        hooks: hookManager.status(),
        execution: executionBackendManager.status()
      });
    });

    this.app.get('/api/checkpoints', requireApiAuth, (req, res) => {
      try {
        const user = (req as any).user;
        const project = this.resolveProjectContext(req.query.projectId);
        const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : '';
        const conversation = conversationId ? conversationManager.getOwned(conversationId, user.id) : undefined;
        const workspacePath = project?.workspacePath || conversation?.workspacePath;
        if (!workspacePath) return res.json({ checkpoints: [], workspacePath: '' });
        res.json({ workspacePath, checkpoints: checkpointManager.list(workspacePath, undefined, Number(req.query.limit) || 30) });
      } catch (error: any) {
        res.status(400).json({ error: error?.message || 'Unable to list checkpoints.' });
      }
    });

    this.app.post('/api/checkpoints/:id/rollback', requireApiAuth, express.json(), (req, res) => {
      try {
        const user = (req as any).user;
        const project = this.resolveProjectContext(req.body?.projectId);
        const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : '';
        const conversation = conversationId ? conversationManager.getOwned(conversationId, user.id) : undefined;
        const workspacePath = project?.workspacePath || conversation?.workspacePath;
        if (!workspacePath) return res.status(400).json({ error: 'Select a project or general conversation workspace first.' });
        res.json(checkpointManager.rollback(workspacePath, String(req.params.id), `web:${user.id}`));
      } catch (error: any) {
        res.status(400).json({ error: error?.message || 'Rollback failed.' });
      }
    });

    this.app.post('/api/editor/request', requireOpenAiAuth, async (req, res) => {
      const content = String(req.body?.content || '').trim();
      if (!content) return res.status(400).json({ error: 'content is required.' });
      try {
        const result = await this.runApiRequest(content, {
          source: 'editor',
          userId: String((req as any).user?.id || 'editor'),
          metadata: {
            editor: req.body?.editor,
            file: req.body?.file,
            selection: req.body?.selection,
            projectId: req.body?.projectId,
            conversationId: req.body?.conversationId
          }
        });
        res.json(result);
      } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Editor request failed.' });
      }
    });

    this.app.post('/api/connectors/inbound/:name', requireOpenAiAuth, async (req, res) => {
      const connector = String(req.params.name || '').trim().toLowerCase();
      const content = String(req.body?.text || req.body?.content || '').trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(connector)) {
        return res.status(400).json({ error: 'Connector name must use letters, numbers, dashes, or underscores.' });
      }
      if (!content || content.length > 100_000) {
        return res.status(400).json({ error: 'text or content is required and must be under 100,000 characters.' });
      }
      try {
        const result = await this.runApiRequest(content, {
          source: 'connector',
          userId: String((req as any).user?.id || 'connector'),
          metadata: {
            connector,
            externalUserId: String(req.body?.userId || '').slice(0, 200),
            threadId: String(req.body?.threadId || '').slice(0, 200),
            projectId: req.body?.projectId,
            conversationId: req.body?.conversationId
          }
        });
        res.json({ ok: true, connector, response: result.text, trajectoryId: result.trajectoryId });
      } catch (error: any) {
        res.status(500).json({ ok: false, connector, error: error?.message || 'Connector request failed.' });
      }
    });

    const sendWhatsAppState = (socket: any) => {
      if (this.lastWhatsAppStatus) {
        socket.emit('whatsapp_status', this.lastWhatsAppStatus);
      }
      if (this.lastWhatsAppQr) {
        socket.emit('whatsapp_qr', { dataUrl: this.lastWhatsAppQr });
      } else {
        socket.emit('whatsapp_qr', { dataUrl: null });
      }
    };

    whatsappEvents.on('qr', async (qr: string) => {
      try {
        this.lastWhatsAppQr = await QRCode.toDataURL(qr);
        this.lastWhatsAppStatus = { status: 'qr' };
        this.io.emit('whatsapp_qr', { dataUrl: this.lastWhatsAppQr });
        this.io.emit('whatsapp_status', this.lastWhatsAppStatus);
      } catch (e: any) {
        console.error('[WebChannel] Failed to generate WhatsApp QR:', e?.message || e);
      }
    });

    whatsappEvents.on('status', (status: WhatsAppStatusPayload) => {
      this.lastWhatsAppStatus = status;
      if (status.status !== 'qr') {
        this.lastWhatsAppQr = null;
        this.io.emit('whatsapp_qr', { dataUrl: null });
      }
      this.io.emit('whatsapp_status', status);
    });

    // Login Endpoint (throttled to resist brute force)
    const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();
    this.app.post('/auth/login', (req, res) => {
      const { username, password } = req.body;
      const key = `${req.ip || req.socket.remoteAddress || 'unknown'}:${String(username || '').toLowerCase()}`;
      const now = Date.now();
      // Bound the attempt map: sweep stale records when it gets large.
      if (loginAttempts.size > 500) {
        for (const [k, v] of loginAttempts) {
          if (v.lockedUntil <= now) loginAttempts.delete(k);
        }
      }
      const entry = loginAttempts.get(key);
      if (entry && entry.lockedUntil > now) {
        return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
      }
      if (entry && entry.lockedUntil <= now) loginAttempts.delete(key);
      const user = this.auth.login(username, password);
      if (user) {
        loginAttempts.delete(key);
        res.json({ token: this.auth.createAuthToken(user.id), username: user.username });
        return;
      }
      const current = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
      current.count += 1;
      if (current.count >= 10) {
        current.lockedUntil = now + 15 * 60 * 1000;
        current.count = 0;
      }
      loginAttempts.set(key, current);
      res.status(401).json({ error: 'Invalid credentials' });
    });

    // Voice Note Upload Endpoint
    // Cap uploads at the multer layer (memoryStorage buffers in RAM before any
    // route-level validation, so unbounded sizes are a memory-exhaustion risk).
    const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
    const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

    this.app.post('/api/attachments', requireApiAuth, imageUpload.array('images', 4), (req, res) => {
      try {
        const user = (req as any).user;
        const files = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
        if (!files.length) return res.status(400).json({ error: 'At least one image is required.' });
        res.status(201).json({ attachments: files.map(file => attachmentStore.put(user.id, file)) });
      } catch (error: any) {
        res.status(400).json({ error: error?.message || 'Image upload failed.' });
      }
    });

    this.app.post('/voice', audioUpload.single('audio'), async (req, res) => {
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

    // TTS Endpoint (authenticated: accepts a web auth token or GITU_API_KEY)
    this.app.post('/tts', requireOpenAiAuth, express.json(), async (req, res) => {
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

    this.app.use('/api', requireApiAuth);

    // ===== DASHBOARD API =====

    this.app.get('/api/learned-skills', requireApiAuth, (req, res) => {
      try {
        const scope = resolveLearningSessionId(req);
        const config = this.readJsonFile('config.json');
        const skills = learnedSkillsManager.list(scope.sessionId).map(skill => ({
          ...skill,
          content: learnedSkillsManager.getContent(skill.name, scope.sessionId)
        }));
        res.json({
          scope: scope.projectId || 'general',
          learning: {
            enabled: config.learning?.enabled === true,
            mode: config.learning?.mode || 'light',
            selfReview: config.learning?.selfReview?.enabled === true,
            skillCreation: config.learning?.skillCreation?.enabled === true,
            executableSkillCreation: config.learning?.skillCreation?.executable?.enabled === true
          },
          background: backgroundWorker.getStatus(),
          skills
        });
      } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Failed to load learned skills' });
      }
    });

    this.app.post('/api/learned-skills/:name/state', requireApiAuth, express.json(), (req, res) => {
      try {
        const scope = resolveLearningSessionId(req);
        const enabled = req.body?.enabled === true;
        const success = learnedSkillsManager.setEnabled(String(req.params.name), enabled, scope.sessionId);
        if (!success) return res.status(404).json({ error: 'Learned skill not found' });
        res.json({ success: true, enabled });
      } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Failed to update learned skill' });
      }
    });

    this.app.post('/api/learned-skills/:name/rollback', requireApiAuth, express.json(), (req, res) => {
      try {
        const scope = resolveLearningSessionId(req);
        const skill = learnedSkillsManager.rollback(String(req.params.name), scope.sessionId);
        if (!skill) return res.status(400).json({ error: 'No previous skill version is available' });
        res.json({ success: true, skill });
      } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Failed to roll back learned skill' });
      }
    });

    this.app.get('/api/portable-skills', requireApiAuth, (_req, res) => {
      res.json({ skills: portableSkillsManager.list() });
    });

    this.app.get('/api/portable-skills/:name', requireApiAuth, (req, res) => {
      const skill = portableSkillsManager.get(String(req.params.name));
      if (!skill) return res.status(404).json({ error: 'Portable skill not found' });
      res.json(skill);
    });

    this.app.post('/api/portable-skills/:name/state', requireApiAuth, express.json(), (req, res) => {
      const success = portableSkillsManager.setEnabled(String(req.params.name), req.body?.enabled === true);
      if (!success) return res.status(404).json({ error: 'Portable skill not found' });
      res.json({ success: true, enabled: req.body?.enabled === true });
    });

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
        const projects = (data.projects || []).map((p: any) => this.decorateProject(p, data));
        res.json({ projects });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/projects', requireApiAuth, express.json(), (req, res) => {
      try {
        const name = typeof req.body?.name === 'string'
          ? req.body.name.trim().replace(/\s+/g, ' ').slice(0, 100)
          : '';
        const description = typeof req.body?.description === 'string'
          ? req.body.description.trim().slice(0, 1_000)
          : '';
        const parentPath = typeof req.body?.parentPath === 'string'
          ? req.body.parentPath.trim()
          : '';
        if (!name) return res.status(400).json({ error: 'Project name is required.' });

        const data = this.readJsonFile('projects_data.json');
        if (!Array.isArray(data.projects)) data.projects = [];
        if (!Array.isArray(data.tasks)) data.tasks = [];
        if (!Array.isArray(data.milestones)) data.milestones = [];
        if (!Array.isArray(data.recurringTasks)) data.recurringTasks = [];
        if (data.projects.some((project: any) => String(project.name || '').toLowerCase() === name.toLowerCase())) {
          return res.status(409).json({ error: 'A project with this name already exists.' });
        }

        const project = {
          id: crypto.randomBytes(4).toString('hex'),
          name,
          description,
          status: 'active',
          createdAt: new Date().toISOString(),
          workspacePath: workspaceManager.createProjectWorkspace(name, parentPath || undefined)
        };
        data.projects.push(project);
        this.writeJsonFile('projects_data.json', data);
        res.status(201).json({ project: this.decorateProject(project, data) });
      } catch (e: any) {
        res.status(500).json({ error: e.message || 'Failed to create project' });
      }
    });

    this.app.get('/api/filesystem/roots', requireApiAuth, (_req, res) => {
      try {
        res.json({
          roots: workspaceManager.listRoots(),
          defaultWorkspaceRoot: workspaceManager.getDefaultWorkspaceRoot()
        });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/filesystem/folders', requireApiAuth, (req, res) => {
      try {
        const folderPath = typeof req.query.path === 'string' ? req.query.path : '';
        res.json(workspaceManager.listDirectory(folderPath));
      } catch (e: any) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.post('/api/filesystem/folders', requireApiAuth, express.json(), (req, res) => {
      try {
        const folderPath = workspaceManager.createFolder(
          String(req.body?.parentPath || ''),
          String(req.body?.name || '')
        );
        res.json({ success: true, path: folderPath });
      } catch (e: any) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.get('/api/conversations', requireApiAuth, (req, res) => {
      const user = (req as any).user;
      res.json({ conversations: conversationManager.list(user.id) });
    });

    this.app.post('/api/conversations', requireApiAuth, express.json(), (req, res) => {
      try {
        const user = (req as any).user;
        res.status(201).json({ conversation: conversationManager.create(user.id) });
      } catch (e: any) {
        res.status(500).json({ error: e.message || 'Failed to create conversation' });
      }
    });

    this.app.get('/api/conversations/:id', requireApiAuth, (req, res) => {
      const user = (req as any).user;
      const conversation = conversationManager.getOwned(String(req.params.id), user.id);
      if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ conversation });
    });

    this.app.put('/api/conversations/:id', requireApiAuth, express.json(), (req, res) => {
      const user = (req as any).user;
      const conversation = conversationManager.update(String(req.params.id), user.id, req.body || {});
      if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ conversation });
    });

    this.app.delete('/api/conversations/:id', requireApiAuth, (req, res) => {
      const user = (req as any).user;
      const conversation = conversationManager.delete(String(req.params.id), user.id);
      if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ success: true });
    });

    this.app.post('/api/projects/:id/workspace/create', requireApiAuth, express.json(), (req, res) => {
      try {
        const data = this.readJsonFile('projects_data.json');
        const project = (data.projects || []).find((p: any) => p.id === req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const parentPath = typeof req.body?.parentPath === 'string' ? req.body.parentPath.trim() : '';
        const workspacePath = workspaceManager.createProjectWorkspace(
          String(project.name || project.title || 'Untitled Project'),
          parentPath || undefined
        );
        project.workspacePath = workspacePath;
        this.writeJsonFile('projects_data.json', data);
        res.json({ success: true, workspacePath, project: this.decorateProject(project, data) });
      } catch (e: any) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.post('/api/projects/:id/workspace', requireApiAuth, express.json(), (req, res) => {
      try {
        const data = this.readJsonFile('projects_data.json');
        const project = (data.projects || []).find((p: any) => p.id === req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const rawPath = typeof req.body?.workspacePath === 'string' ? req.body.workspacePath.trim() : '';
        if (!rawPath) {
          delete project.workspacePath;
          this.writeJsonFile('projects_data.json', data);
          return res.json({ success: true, project: this.decorateProject(project, data) });
        }

        const workspacePath = path.resolve(rawPath);
        workspaceManager.assertAllowed(workspacePath);
        if (!this.isExistingDirectory(workspacePath)) {
          return res.status(400).json({ error: 'Workspace folder does not exist or is not a directory.' });
        }

        project.workspacePath = workspacePath;
        this.writeJsonFile('projects_data.json', data);
        res.json({ success: true, project: this.decorateProject(project, data) });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/projects/:id/open-workspace', requireApiAuth, express.json(), (req, res) => {
      try {
        const data = this.readJsonFile('projects_data.json');
        const project = (data.projects || []).find((p: any) => p.id === req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const workspacePath = typeof project.workspacePath === 'string' ? project.workspacePath.trim() : '';
        if (!workspacePath) return res.status(400).json({ error: 'Project has no workspace folder.' });
        if (!this.isExistingDirectory(workspacePath)) {
          return res.status(400).json({ error: 'Workspace folder does not exist or is not a directory.' });
        }

        this.openLocalFolder(workspacePath);
        res.json({ success: true, workspacePath });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    // Models API
    this.app.get('/api/models', (req, res) => {
      const models = modelManager.listModels();
      // MockProvider is an internal test/fallback implementation and pool
      // providers are resilience fallbacks. Never expose either as a
      // selectable user model in the product UI.
      const isInternalModel = (id: string) =>
        id === 'mock' ||
        /_pool_\d+$/.test(id) ||
        id.startsWith('resilient:') ||
        id.startsWith('error');
      const runtimeModels = ModelRegistry.getAll().filter(m => !isInternalModel(m.id));
      const current = ModelRegistry.getCurrentModelId();

      // Merge metadata if available; derive provider/model for built-ins
      // (openrouter / nvidia / opencode) that have no models.json entry.
      const result = runtimeModels.map(m => {
        const config = models.find(c => c.id === m.id);
        let provider = config?.provider || 'unknown';
        let modelName = config?.modelName || '';
        if (!config) {
          if (m.id === 'openrouter') {
            provider = 'openrouter';
            modelName = process.env.OPENROUTER_MODEL || '';
          } else if (m.id === 'nvidia') {
            provider = 'nvidia';
            modelName = process.env.NVIDIA_MODEL || '';
          } else if (m.id === 'opencode') {
            provider = 'opencode';
            modelName = process.env.OPENCODE_MODEL || '';
          }
        }
        return {
          id: m.id,
          name: m.name,
          provider,
          modelName: modelName || m.id,
          level: m.level || 'auto',
          active: m.id === current
        };
      });

      res.json({ models: result, current: current === 'mock' ? null : current });
    });

    this.app.get('/api/models/health', requireApiAuth, (_req, res) => {
      res.json({ providers: modelResilienceManager.list() });
    });

    this.app.post('/api/models/health/reset', requireApiAuth, express.json(), (req, res) => {
      const providerId = typeof req.body?.providerId === 'string' ? req.body.providerId.trim() : '';
      modelResilienceManager.reset(providerId || undefined);
      res.json({ success: true, providers: modelResilienceManager.list() });
    });

    this.app.post('/api/models/use', express.json(), (req, res) => {
      const { id } = req.body;
      if (ModelRegistry.setCurrentModel(id)) {
        res.json({ success: true, current: id });
        console.log(`[WebChannel] Switched model to: ${id}`);
      } else {
        res.status(404).json({ error: 'Model not found' });
      }
    });

    this.app.post('/api/models/add', express.json(), (req, res) => {
      let { name, provider, modelId, baseUrl, apiKey, maxOutputTokens, level } = req.body;
      const parsedMaxOutputTokens = Number(maxOutputTokens);
      const outputCap = Number.isFinite(parsedMaxOutputTokens) && parsedMaxOutputTokens > 0
        ? Math.floor(parsedMaxOutputTokens)
        : undefined;
      const modelLevel = ['low', 'medium', 'high', 'max'].includes(level) ? level : undefined;

      if (!name || !modelId) {
        return res.status(400).json({ error: 'Name and Model ID are required.' });
      }

      // Default Base URL for OpenRouter
      if (provider === 'openrouter' && !baseUrl) {
        baseUrl = 'https://openrouter.ai/api/v1';
      }

      // Default Base URL for Ollama
      if (provider === 'ollama' && !baseUrl) {
        baseUrl = 'http://localhost:11434/v1';
      }

      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

      // Add to config (persistent)
      const added = modelManager.addModel({
        id,
        name,
        provider: provider || 'openai',
        modelName: modelId,
        baseUrl,
        maxOutputTokens: outputCap,
        level: modelLevel
      });
      if (!added) {
        return res.status(409).json({ error: `A model named '${id}' already exists.` });
      }

      // Register runtime
      const model = new GenericOpenAIProvider(
        id,
        name,
        baseUrl,
        resolveModelApiKey(provider || 'openai', apiKey),
        modelId,
        undefined,
        outputCap,
        modelLevel
      );
      ModelRegistry.register(model);

      res.json({ success: true, id });
      console.log(`[WebChannel] Added new model: ${name}`);
    });

    // OpenCode Zen dynamic model catalog + runtime model switching
    this.app.get('/api/models/opencode', async (_req, res) => {
      const apiKey = process.env.OPENCODE_API_KEY;
      if (!apiKey) {
        return res.status(400).json({ error: 'OPENCODE_API_KEY is not set in the environment.' });
      }
      try {
        const models = await OpenCodeProvider.fetchModels(apiKey);
        res.json({ models });
      } catch (error: any) {
        res.status(502).json({ error: error?.message || 'Failed to fetch OpenCode Zen models.' });
      }
    });

    // Allow fetching the catalog with a key typed into the form but not yet
    // saved to .env (saves the “Save first, then Fetch” dance).
    this.app.post('/api/models/opencode', express.json(), async (req, res) => {
      const typed = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
      const apiKey = typed && typed !== '********' ? typed : (process.env.OPENCODE_API_KEY || '');
      if (!apiKey) {
        return res.status(400).json({ error: 'OPENCODE_API_KEY is not set in the environment.' });
      }
      try {
        const models = await OpenCodeProvider.fetchModels(apiKey);
        res.json({ models });
      } catch (error: any) {
        res.status(502).json({ error: error?.message || 'Failed to fetch OpenCode Zen models.' });
      }
    });

    this.app.post('/api/models/opencode/use', express.json(), (req, res) => {
      const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
      if (!model) return res.status(400).json({ error: 'model is required.' });
      const provider = ModelRegistry.get('opencode') as any;
      if (!provider || typeof provider.setModel !== 'function') {
        return res.status(404).json({ error: 'OpenCode Zen provider is not registered. Set OPENCODE_API_KEY (and a model) and restart.' });
      }
      provider.setModel(model);
      ModelRegistry.setCurrentModel('opencode');
      res.json({ success: true, model });
      console.log(`[WebChannel] Switched OpenCode Zen model to: ${model}`);
    });

    // ===== ANALYTICS API =====

    this.app.get('/api/analytics/overview', (_req, res) => {
      try {
        res.json(analyticsTracker.getOverview());
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/analytics/daily', (req, res) => {
      try {
        const days = Math.min(30, Math.max(1, parseInt(String(req.query.days)) || 7));
        res.json({ daily: analyticsTracker.getDailyStats(days) });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/analytics/agents', (_req, res) => {
      try {
        res.json({ agents: analyticsTracker.getAgentPerformance() });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/analytics/goals', (_req, res) => {
      try {
        res.json(analyticsTracker.getGoalStats());
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    // ===== ANALYTICS API =====

    this.app.get('/api/analytics/summary', (_req, res) => {
      try {
        const overview = analyticsTracker.getOverview();
        const daily = analyticsTracker.getDailyStats(14);

        // Build dailyMessages for the chart
        const dailyMessages = daily.map(d => ({ date: d.date, count: d.messages + d.tasks }));

        // Build topSkills from tool_call events
        const skillMap: Record<string, number> = {};
        const allEvents = (analyticsTracker as any).data?.events || [];
        for (const e of allEvents) {
          if (e.type === 'tool_call' && e.metadata?.toolName) {
            const name = e.metadata.toolName;
            skillMap[name] = (skillMap[name] || 0) + 1;
          }
        }
        const topSkills = Object.entries(skillMap)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);

        // Recent events (last 30)
        const recentEvents = allEvents
          .slice(-30)
          .reverse()
          .map((e: any) => ({
            type: e.type,
            description: e.metadata?.toolName
              ? `Tool: ${e.metadata.toolName}`
              : e.type === 'message' ? 'User message'
                : e.type.replace(/_/g, ' '),
            timestamp: new Date(e.timestamp).toISOString()
          }));

        res.json({
          totalMessages: overview.totalMessages,
          totalToolCalls: overview.totalToolCalls,
          avgResponseTime: overview.avgDurationMs,
          totalErrors: overview.totalFailures,
          dailyMessages,
          topSkills,
          recentEvents
        });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    // ===== COLLABORATION API =====

    this.app.get('/api/collaboration/messages', (req, res) => {
      try {
        const agentId = req.query.agentId as string | undefined;
        const limit = Math.min(100, parseInt(String(req.query.limit)) || 50);
        const messages = agentSwarm.getMessages(agentId, limit);
        res.json({ messages });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/collaboration/sessions', (_req, res) => {
      try {
        const sessions = agentSwarm.getCollaborations(20);
        res.json({ sessions });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/collaboration/sessions/:id', (req, res) => {
      try {
        const session = agentSwarm.getCollaboration(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        res.json(session);
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/collaboration/start', express.json(), async (req, res) => {
      try {
        const { agentNames, goal } = req.body;
        if (!agentNames || !goal) return res.status(400).json({ error: 'agentNames and goal required' });
        const names = String(agentNames).split(',').map((s: string) => s.trim()).filter(Boolean);
        if (names.length < 2) return res.status(400).json({ error: 'Need at least 2 agents' });
        const session = await agentSwarm.collaborate(names, goal);
        res.json(session);
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    // ===== CONFIG API =====

    this.app.get('/api/config', (_req, res) => {
      try {
        const configPath = path.join(process.cwd(), 'config.json');
        if (fs.existsSync(configPath)) {
          const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          res.json(this.maskConfigSecrets(raw));
        } else {
          res.json({});
        }
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/config', express.json(), (req, res) => {
      try {
        const configPath = path.join(process.cwd(), 'config.json');
        const current = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : {};

        const requestBody = req.body && typeof req.body === 'object' ? req.body : {};
        const { keys: requestedKeys, ...safeBody } = requestBody;
        const updated = { ...current, ...safeBody };
        // Credentials live only in .env/process.env. Remove legacy copies so
        // config.json is safe to commit and dashboard reads cannot expose them.
        delete updated.keys;

        // Save to config.json (atomic)
        this.atomicWriteFile(configPath, JSON.stringify(updated, null, 2));

        // Update .env for keys
        const keys = requestedKeys;
        const { llm } = requestBody;
        if (keys || llm) {
          let envContent = '';
          if (fs.existsSync('.env')) {
            envContent = fs.readFileSync('.env', 'utf-8');
          }

          const updateEnv = (key: string, value: string) => {
            if (!value || value === '********') return;
            value = String(value).replace(/[\r\n]/g, '').trim();
            if (!value) return;
            const regex = new RegExp(`^${key}=.*`, 'm');
            if (regex.test(envContent)) {
              envContent = envContent.replace(regex, `${key}=${value}`);
            } else {
              envContent += `\n${key}=${value}`;
            }
            process.env[key] = value;
          };

          if (keys) {
            updateEnv('OPENROUTER_API_KEY', keys.openRouter);
            updateEnv('NVIDIA_API_KEY', keys.nvidia);
            updateEnv('SERPER_API_KEY', keys.serper);
            updateEnv('OPENAI_API_KEY', keys.openai); // Config supports openai key too?
            updateEnv('ANTHROPIC_API_KEY', keys.anthropic);
            updateEnv('GEMINI_API_KEY', keys.gemini);
            updateEnv('ELEVENLABS_API_KEY', keys.elevenLabs);
            updateEnv('DEEPGRAM_API_KEY', keys.deepgram);

            // Check specific key names from frontend:
            // The frontend sends: openRouter, nvidia, serper, brave, elevenLabs, deepgram
            updateEnv('BRAVE_SEARCH_API_KEY', keys.brave);

            // OpenCode Zen fallback provider
            updateEnv('OPENCODE_API_KEY', keys.opencode);
            updateEnv('OPENCODE_MODEL', keys.opencodeModel);
          }

          if (llm && String(llm.provider).toLowerCase() === 'openrouter') {
            updateEnv('OPENROUTER_MODEL', llm.model);
          }

          this.atomicWriteFile('.env', envContent.trim());
        }

        // Activate the saved provider/model at runtime so the change applies
        // immediately instead of only after a restart.
        const providerStatus = this.applyConfiguredProvider(updated);

        // Keep OpenCode Zen registered as a fallback (matching boot behavior)
        // even when it is not the provider selected in Settings.
        const ocFallbackKey = process.env.OPENCODE_API_KEY;
        const ocFallbackModel = String(process.env.OPENCODE_MODEL || '').trim();
        if (ocFallbackKey && ocFallbackModel && !ModelRegistry.get('opencode')) {
          ModelRegistry.register(new OpenCodeProvider(ocFallbackKey, ocFallbackModel));
          console.log(`[WebChannel] Registered OpenCode Zen fallback with model ${ocFallbackModel}`);
        }

        res.json({ success: true, config: this.maskConfigSecrets(updated), providerStatus });
      } catch (e: any) {
        console.error('[WebChannel] Failed to save config:', e);
        res.status(500).json({ error: e.message });
      }
    });

    // ===== COST TRACKING API =====

    this.app.get('/api/analytics/costs', (_req, res) => {
      try {
        const days = parseInt(String((_req as any).query?.days)) || 14;
        res.json(costTracker.getSummary(days));
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    // ===== PROACTIVE ENGINE API =====

    this.app.get('/api/proactive/suggestions', async (_req, res) => {
      try {
        const suggestions = await proactiveEngine.generateSuggestions();
        res.json({ suggestions, all: proactiveEngine.getSuggestions() });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/proactive/dismiss', express.json(), (req, res) => {
      try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ error: 'id required' });
        const dismissed = proactiveEngine.dismiss(id);
        res.json({ dismissed });
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
        const user = this.auth.getUserByToken(token);
        if (user) {
          this.auth.createSession(socket.id, user.id);
          socket.join(user.id);
          socket.data.userId = user.id;
          console.log(`[WebChannel] User ${user.username} authenticated via token on socket ${socket.id}`);
          socket.emit('login_success', { username: user.username, socketId: socket.id });
          sendWhatsAppState(socket);
        } else {
          socket.emit('auth_error', { message: 'Invalid or expired token' });
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
          sendWhatsAppState(socket);
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
            serperKey: process.env.SERPER_API_KEY ? '********' : '',
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
            // Ensure we replace the last arg which is the path (guard empty arrays)
            if (Array.isArray(fsArgs) && fsArgs.length > 0) {
              if (config.filesystemMode === 'full') {
                const platformRoot = path.parse(process.cwd()).root || '/';
                fsArgs[fsArgs.length - 1] = platformRoot;
              } else {
                fsArgs[fsArgs.length - 1] = './';
              }
            }
          }

          this.atomicWriteFile('config.json', JSON.stringify(config, null, 2));

          // 2. Update .env
          let envContent = '';
          if (fs.existsSync('.env')) {
            envContent = fs.readFileSync('.env', 'utf-8');
          }

          const updateEnv = (key: string, value: string) => {
            if (!value || value === '********') return;
            value = String(value).replace(/[\r\n]/g, '').trim();
            if (!value) return;
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
          if (String(data.model || '').toLowerCase() === 'openrouter') {
            updateEnv('OPENROUTER_MODEL', data.aiModel);
          }
          updateEnv('NVIDIA_API_KEY', data.nvidiaKey);
          updateEnv('SERPER_API_KEY', data.serperKey);
          updateEnv('OPENAI_API_KEY', data.openaiKey);
          updateEnv('ANTHROPIC_API_KEY', data.anthropicKey);
          updateEnv('GEMINI_API_KEY', data.geminiKey);
          updateEnv('ELEVENLABS_API_KEY', data.elevenLabsKey);
          updateEnv('ELEVENLABS_VOICE_ID', data.elevenLabsVoice);
          updateEnv('DEEPGRAM_API_KEY', data.deepgramKey);

          this.atomicWriteFile('.env', envContent.trim());

          socket.emit('settings_saved', { message: 'Settings saved successfully.' });
        } catch (e: any) {
          socket.emit('error', 'Failed to save settings: ' + e.message);
        }
      });

      socket.on('message', (payload: any) => {
        if (!this.auth.isAuthenticated(socket.id)) {
          socket.emit('error', 'Authentication required. Please log in.');
          return;
        }

        // Phase 5 ASK path: the UI answered a pending approval (Allow/Deny).
        if (payload && typeof payload === 'object' && payload.type === 'approval_response'
          && typeof payload.approvalId === 'string') {
          if (this.handler) {
            const user = this.auth.getUserBySession(socket.id);
            const stableUserId = user?.id || socket.data.userId || socket.id;
            this.handler({
              id: uuidv4(),
              channel: 'approval',
              senderId: `${stableUserId}:approval`,
              content: payload.allowed === true ? 'allow' : 'deny',
              timestamp: Date.now(),
              metadata: {
                approvalId: payload.approvalId,
                allowed: payload.allowed === true,
                userId: stableUserId
              }
            });
          }
          return;
        }

        // Repository warmth: the UI asked for an on-demand index refresh.
        if (payload && typeof payload === 'object' && payload.type === 'repo_refresh') {
          if (this.handler) {
            const user = this.auth.getUserBySession(socket.id);
            const stableUserId = user?.id || socket.data.userId || socket.id;
            const projectContext = this.resolveProjectContext(payload?.projectId);
            const requestedConversationId = typeof payload?.conversationId === 'string'
              ? payload.conversationId.trim()
              : '';
            const conversation = !projectContext && requestedConversationId
              ? conversationManager.getOwned(requestedConversationId, stableUserId)
              : undefined;
            const resolvedWorkspacePath = projectContext?.workspacePath
              || conversation?.workspacePath;
            if (resolvedWorkspacePath) {
              this.handler({
                id: uuidv4(),
                channel: 'web',
                senderId: `${stableUserId}:repo-refresh`,
                content: '__repo_refresh__',
                timestamp: Date.now(),
                metadata: {
                  repoRefresh: true,
                  username: user ? user.username : 'Anonymous',
                  baseUserId: stableUserId,
                  projectId: projectContext?.id,
                  conversationId: conversation?.id,
                  projectWorkspacePath: resolvedWorkspacePath
                }
              });
            } else {
              socket.emit('error', 'No attached workspace to refresh. Attach a project folder first.');
            }
          }
          return;
        }

        const text = typeof payload === 'string'
          ? payload
          : (typeof payload?.text === 'string' ? payload.text : '');
        if (!text.trim()) return;

        if (this.handler) {
          const user = this.auth.getUserBySession(socket.id);
          const stableUserId = user?.id || socket.data.userId || socket.id;
          const projectContext = this.resolveProjectContext(payload?.projectId);
          const requestedConversationId = typeof payload?.conversationId === 'string'
            ? payload.conversationId.trim()
            : '';
          const conversation = !projectContext && requestedConversationId
            ? conversationManager.getOwned(requestedConversationId, stableUserId)
            : undefined;
          if (!projectContext && !conversation) {
            socket.emit('error', 'Select or create a General conversation before sending a message.');
            return;
          }
          const resolvedWorkspacePath = projectContext?.workspacePath
            || conversation?.workspacePath;
          const scopedUserId = projectContext?.id
            ? `${stableUserId}:project:${projectContext.id}`
            : `${stableUserId}:conversation:${conversation!.id}`;
          socket.join(scopedUserId);
          const msg: Message = {
            id: uuidv4(),
            channel: 'web',
            senderId: scopedUserId,
            content: text,
            timestamp: Date.now(),
            metadata: {
              username: user ? user.username : 'Anonymous',
              baseUserId: stableUserId,
              projectId: projectContext?.id,
              projectName: projectContext?.name,
              projectDescription: projectContext?.description,
              conversationId: conversation?.id,
              projectWorkspacePath: resolvedWorkspacePath,
              projectWorkspaceExists: resolvedWorkspacePath
                ? workspaceManager.isExistingDirectory(resolvedWorkspacePath)
                : false,
              attachments: attachmentStore.resolveMany(payload?.attachments, stableUserId)
            }
          };
          this.handler(msg);
        }
      });

      socket.on('disconnect', () => {
        this.auth.endSession(socket.id);
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
    const capture = this.apiCaptures.get(userId);
    if (capture) capture.messages.push(text);
    // userId maps to a socket.io room joined by the authenticated user
    this.io.to(userId).emit('message', {
      text,
      ...this.extractChatScope(userId)
    });
  }

  sendMedia(userId: string, media: MediaPayload) {
    const capture = this.apiCaptures.get(userId);
    if (capture) capture.media.push(media);
    const payload = { ...media } as MediaPayload;
    if (payload.path && (!payload.url || payload.url.trim() === '')) {
      const rel = path.relative(process.cwd(), payload.path);
      const normalized = rel.split(path.sep).join('/');
      if (normalized.startsWith('artifacts/')) {
        payload.url = `/api/artifacts/${normalized.slice('artifacts/'.length)}`;
      }
    }
    this.io.to(userId).emit('media', {
      ...payload,
      ...this.extractChatScope(userId)
    });
  }

  sendStream(userId: string, chunk: string) {
    const cleaned = stripShellStreamMarker(chunk);
    if (!cleaned.chunk) return;
    const capture = this.apiCaptures.get(userId);
    if (capture) capture.chunks.push(cleaned.chunk);
    this.io.to(userId).emit('stream_chunk', {
      chunk: cleaned.chunk,
      ...this.extractChatScope(userId)
    });
  }

  sendStreamEvent(userId: string, event: StreamEventPayload) {
    const capture = this.apiCaptures.get(userId);
    if (capture) {
      capture.events.push(event);
      try { capture.onEvent?.(event); } catch { /* Client disconnects must not stop the agent. */ }
    }
    this.io.to(userId).emit(event.type, {
      ...event,
      ...this.extractChatScope(userId)
    });
  }

  onMessage(handler: (msg: Message) => void | Promise<void>) {
    this.handler = handler;
  }

  private async runApiRequest(
    content: string,
    options: { source: 'api' | 'batch' | 'editor' | 'connector'; userId: string; metadata?: Record<string, unknown> },
    onEvent?: (event: StreamEventPayload) => void
  ): Promise<{ text: string; events: StreamEventPayload[]; trajectoryId: string }> {
    if (!this.handler) throw new Error('Agent gateway is not ready.');
    const startedAt = Date.now();
    const trajectoryId = trajectoryStore.createId();
    const senderId = `${options.userId}:${options.source}:${trajectoryId}`;
    const capture: ApiCapture = { messages: [], chunks: [], events: [], media: [], onEvent };
    this.apiCaptures.set(senderId, capture);
    let status: 'completed' | 'failed' = 'completed';
    let errorText = '';
    try {
      await this.handler({
        id: trajectoryId,
        channel: this.name,
        senderId,
        content,
        timestamp: startedAt,
        metadata: { ...options.metadata, api: true, source: options.source }
      });
      const done = [...capture.events].reverse().find(event => event.type === 'assistant_done');
      const failed = [...capture.events].reverse().find(event => event.type === 'assistant_error');
      if (failed) throw new Error(failed.error || failed.text || 'Agent request failed.');
      // Runs the agent deliberately stopped without completing (safety budget,
      // blocked loops) must surface as real errors, not HTTP 200 apologies.
      if (done && done.ok === false) {
        throw new Error(String(done.finalText || done.text || 'Agent reported the task could not be completed.'));
      }
      const text = String(done?.finalText || done?.text || capture.messages[capture.messages.length - 1] || capture.chunks.join('')).trim();
      trajectoryStore.save({
        id: trajectoryId, source: options.source, userId: options.userId,
        request: { content, metadata: options.metadata }, events: capture.events, response: text,
        status, startedAt, completedAt: Date.now(), durationMs: Date.now() - startedAt
      });
      return { text, events: capture.events, trajectoryId };
    } catch (error: any) {
      status = 'failed';
      errorText = error?.message || 'Agent request failed.';
      trajectoryStore.save({
        id: trajectoryId, source: options.source, userId: options.userId,
        request: { content, metadata: options.metadata }, events: capture.events, response: '',
        status, error: errorText, startedAt, completedAt: Date.now(), durationMs: Date.now() - startedAt
      });
      throw error;
    } finally {
      this.apiCaptures.delete(senderId);
    }
  }

  private extractProjectIdFromScopedUserId(userId: string): string | undefined {
    const match = /:project:([^:]+)$/.exec(String(userId || ''));
    return match ? match[1] : undefined;
  }

  private extractConversationIdFromScopedUserId(userId: string): string | undefined {
    const match = /:conversation:([^:]+)$/.exec(String(userId || ''));
    return match ? match[1] : undefined;
  }

  private extractChatScope(userId: string) {
    return {
      projectId: this.extractProjectIdFromScopedUserId(userId),
      conversationId: this.extractConversationIdFromScopedUserId(userId)
    };
  }

  private isExistingDirectory(dirPath: string): boolean {
    try {
      return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
    } catch {
      return false;
    }
  }

  private decorateProject(project: any, data: any): any {
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
    const projectTasks = tasks.filter((t: any) => t.projectId === project.id);
    const total = projectTasks.length;
    const done = projectTasks.filter((t: any) => t.status === 'done').length;
    const progress = total > 0 ? Math.round((done / total) * 100) : 0;
    const workspacePath = typeof project.workspacePath === 'string' ? project.workspacePath.trim() : '';

    return {
      ...project,
      workspacePath,
      workspaceExists: workspacePath ? this.isExistingDirectory(workspacePath) : false,
      workspaceName: workspacePath ? path.basename(workspacePath) : '',
      progress,
      taskCount: total,
      doneCount: done
    };
  }

  private resolveProjectContext(projectId: unknown): any | undefined {
    const id = typeof projectId === 'string' ? projectId.trim() : '';
    if (!id) return undefined;
    const data = this.readJsonFile('projects_data.json');
    const project = (data.projects || []).find((p: any) => p.id === id);
    if (!project) return undefined;
    return this.decorateProject(project, data);
  }

  private openLocalFolder(folderPath: string) {
    const command = process.platform === 'win32'
      ? 'explorer.exe'
      : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const child = spawn(command, [folderPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
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

  private atomicWriteFile(filePath: string, data: string) {
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
  }

  private writeJsonFile(filename: string, data: any) {
    const filePath = path.join(process.cwd(), filename);
    this.atomicWriteFile(filePath, JSON.stringify(data, null, 2));
  }

  /**
   * Register the provider selected in config (model/aiModel/llm) in the
   * ModelRegistry and make it the current model, so a Settings save takes
   * effect immediately instead of after a restart. Returns a status the UI can
   * surface when the provider cannot be activated (e.g. invalid API key).
   */
  private applyConfiguredProvider(config: any): { activated: boolean; provider: string; error?: string } {
    const provider = String(config?.model || config?.llm?.provider || '').trim().toLowerCase();
    const model = String(config?.aiModel || config?.llm?.model || '').trim();
    if (provider === 'openrouter') {
      const key = process.env.OPENROUTER_API_KEY || '';
      if (!isProviderKeyValid('openrouter', key)) {
        const error = 'OpenRouter API key is missing or does not look like a valid sk-or-v1- key. Paste the key from openrouter.ai in API keys.';
        console.warn(`[WebChannel] ${error}`);
        return { activated: false, provider, error };
      }
      const modelName = model || process.env.OPENROUTER_MODEL || '';
      if (!modelName) {
        const error = 'OpenRouter is selected but no model id is set. Enter the model id in Settings.';
        console.warn(`[WebChannel] ${error}`);
        return { activated: false, provider, error };
      }
      ModelRegistry.register(new OpenRouterProvider(key, modelName));
      ModelRegistry.setCurrentModel('openrouter');
      modelResilienceManager.reset('openrouter');
      console.log(`[WebChannel] Activated OpenRouter provider with model ${modelName}`);
      return { activated: true, provider };
    } else if (provider === 'nvidia') {
      const key = process.env.NVIDIA_API_KEY || '';
      if (!isProviderKeyValid('nvidia', key)) {
        const error = 'NVIDIA API key is missing or does not look like a valid nvapi- key. Paste the key from build.nvidia.com in API keys.';
        console.warn(`[WebChannel] ${error}`);
        return { activated: false, provider, error };
      }
      const modelName = model || process.env.NVIDIA_MODEL || '';
      if (!modelName) {
        const error = 'NVIDIA is selected but no model id is set. Enter the model id in Settings.';
        console.warn(`[WebChannel] ${error}`);
        return { activated: false, provider, error };
      }
      ModelRegistry.register(new NvidiaProvider(key, modelName, config?.nvidia?.thinking !== false));
      ModelRegistry.setCurrentModel('nvidia');
      modelResilienceManager.reset('nvidia');
      console.log(`[WebChannel] Activated NVIDIA provider with model ${modelName}`);
      return { activated: true, provider };
    } else if (provider === 'opencode') {
      const key = process.env.OPENCODE_API_KEY || '';
      if (!key) {
        const error = 'OpenCode Zen API key is missing. Paste the key from opencode.ai/auth in API keys.';
        console.warn(`[WebChannel] ${error}`);
        return { activated: false, provider, error };
      }
      const modelName = model || process.env.OPENCODE_MODEL || '';
      if (!modelName) {
        const error = 'OpenCode Zen is selected but no model id is set. Pick or enter a model id in Settings.';
        console.warn(`[WebChannel] ${error}`);
        return { activated: false, provider, error };
      }
      ModelRegistry.register(new OpenCodeProvider(key, modelName));
      ModelRegistry.setCurrentModel('opencode');
      modelResilienceManager.reset('opencode');
      console.log(`[WebChannel] Activated OpenCode Zen provider with model ${modelName}`);
      return { activated: true, provider };
    }
    return { activated: false, provider: provider || 'unknown', error: 'Unknown provider selected in Settings.' };
  }

  private maskConfigSecrets(config: any): any {
    const masked = JSON.parse(JSON.stringify(config || {}));
    if (!masked.aiModel && (process.env.OPENROUTER_MODEL || process.env.OPENCODE_MODEL)) {
      masked.aiModel = process.env.OPENROUTER_MODEL || process.env.OPENCODE_MODEL;
    }
    if (masked.llm && !masked.llm.model && (process.env.OPENROUTER_MODEL || process.env.OPENCODE_MODEL)) {
      masked.llm.model = process.env.OPENROUTER_MODEL || process.env.OPENCODE_MODEL;
    }
    const envKeys: Record<string, string> = {
      openRouter: 'OPENROUTER_API_KEY',
      nvidia: 'NVIDIA_API_KEY',
      serper: 'SERPER_API_KEY',
      brave: 'BRAVE_SEARCH_API_KEY',
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      gemini: 'GEMINI_API_KEY',
      elevenLabs: 'ELEVENLABS_API_KEY',
      deepgram: 'DEEPGRAM_API_KEY',
      opencode: 'OPENCODE_API_KEY'
    };
    // Mask only keys that are actually usable, so a placeholder/fragment key
    // (e.g. a broken OpenRouter key) shows up empty in Settings instead of
    // masquerading as a valid saved key.
    masked.keys = Object.fromEntries(
      Object.entries(envKeys).map(([name, envName]) => {
        const envValue = process.env[envName] || '';
        const providerForCheck =
          envName === 'OPENROUTER_API_KEY' ? 'openrouter' :
          envName === 'NVIDIA_API_KEY' ? 'nvidia' : '';
        const visible = providerForCheck
          ? isProviderKeyValid(providerForCheck, envValue)
          : envValue.length > 0;
        return [name, visible ? '********' : ''];
      })
    );
    return masked;
  }
}
