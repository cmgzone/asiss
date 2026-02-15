import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

dotenv.config();

const execFileAsync = promisify(execFile);

type SttProvider = 'deepgram' | 'whisper';

export class SttService {
    private apiKey: string | undefined;
    private provider: SttProvider;
    private whisperPython: string;
    private whisperScript: string;
    private whisperModel: string;
    private whisperLanguage: string | undefined;
    private whisperTimeoutMs: number;

    constructor() {
        this.apiKey = process.env.DEEPGRAM_API_KEY;
        const providerRaw = String(process.env.STT_PROVIDER || 'deepgram').trim().toLowerCase();
        this.provider = providerRaw === 'whisper' || providerRaw === 'local' ? 'whisper' : 'deepgram';
        this.whisperPython = String(process.env.WHISPER_PYTHON || 'python').trim();
        this.whisperScript = String(process.env.WHISPER_SCRIPT || path.join('scripts', 'whisper_transcribe.py')).trim();
        this.whisperModel = String(process.env.WHISPER_MODEL || 'tiny').trim();
        const languageRaw = String(process.env.WHISPER_LANGUAGE || '').trim();
        this.whisperLanguage = languageRaw ? languageRaw : undefined;
        const timeoutRaw = Number(process.env.WHISPER_TIMEOUT_MS || 120000);
        this.whisperTimeoutMs = Number.isFinite(timeoutRaw) ? Math.max(1000, Math.floor(timeoutRaw)) : 120000;
    }

    async transcribe(audioBuffer: Buffer, mimetype: string = 'audio/webm'): Promise<string> {
        if (this.provider === 'whisper') {
            return this.transcribeLocalWhisper(audioBuffer, mimetype);
        }
        if (!this.apiKey) {
            throw new Error('DEEPGRAM_API_KEY is not configured.');
        }

        try {
            console.log(`[SttService] Transcribing ${audioBuffer.length} bytes via Deepgram...`);

            const response = await axios.post(
                'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true',
                audioBuffer,
                {
                    headers: {
                        'Authorization': `Token ${this.apiKey}`,
                        'Content-Type': mimetype
                    }
                }
            );

            const transcript = response.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;

            if (!transcript) {
                console.warn('[SttService] No transcript returned.');
                return '';
            }

            console.log(`[SttService] Transcript: "${transcript}"`);
            return transcript;
        } catch (error: any) {
            console.error('[SttService] Deepgram API Error:', error.response?.data || error.message);
            throw new Error(`Transcription failed: ${error.message}`);
        }
    }

    private async transcribeLocalWhisper(audioBuffer: Buffer, mimetype: string): Promise<string> {
        const scriptPath = path.isAbsolute(this.whisperScript)
            ? this.whisperScript
            : path.join(process.cwd(), this.whisperScript);
        if (!fs.existsSync(scriptPath)) {
            throw new Error(`WHISPER_SCRIPT not found at ${scriptPath}`);
        }

        const ext = this.extensionFromMime(mimetype);
        const tempDir = path.join(process.cwd(), 'artifacts', 'stt');
        fs.mkdirSync(tempDir, { recursive: true });
        const fileName = `whisper-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
        const filePath = path.join(tempDir, fileName);
        fs.writeFileSync(filePath, audioBuffer);

        try {
            const args = [
                scriptPath,
                '--input',
                filePath,
                '--model',
                this.whisperModel
            ];
            if (this.whisperLanguage) {
                args.push('--language', this.whisperLanguage);
            }

            console.log(`[SttService] Transcribing ${audioBuffer.length} bytes via local Whisper (${this.whisperModel})...`);
            const { stdout, stderr } = await execFileAsync(
                this.whisperPython,
                args,
                {
                    timeout: this.whisperTimeoutMs,
                    windowsHide: true,
                    maxBuffer: 10 * 1024 * 1024
                }
            );

            if (stderr && stderr.trim()) {
                console.warn(`[SttService] Whisper stderr: ${stderr.trim()}`);
            }

            const transcript = String(stdout || '').trim();
            if (!transcript) {
                throw new Error('Local Whisper returned empty transcript.');
            }
            console.log(`[SttService] Transcript: "${transcript}"`);
            return transcript;
        } catch (error: any) {
            throw new Error(`Local Whisper failed: ${error.message || error}`);
        } finally {
            try {
                fs.unlinkSync(filePath);
            } catch {
                // ignore cleanup errors
            }
        }
    }

    private extensionFromMime(mimetype: string): string {
        const type = String(mimetype || '').toLowerCase();
        if (type.includes('wav')) return 'wav';
        if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
        if (type.includes('ogg')) return 'ogg';
        if (type.includes('flac')) return 'flac';
        if (type.includes('aac')) return 'aac';
        if (type.includes('mp4')) return 'mp4';
        if (type.includes('webm')) return 'webm';
        return 'webm';
    }
}

export const sttService = new SttService();
