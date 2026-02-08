import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs';

dotenv.config();

export class TtsService {
    private apiKey: string | undefined;
    private voiceId: string | undefined;

    constructor() {
        this.apiKey = process.env.ELEVENLABS_API_KEY;
        this.voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Default to Rachel
    }

    async generate(text: string): Promise<Buffer> {
        // Reload env/config in case it changed at runtime via settings
        // (Assuming process.env is updated by server.ts save)
        this.apiKey = process.env.ELEVENLABS_API_KEY;
        this.voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

        if (!this.apiKey) {
            throw new Error('ELEVENLABS_API_KEY is not configured.');
        }

        try {
            console.log(`[TtsService] Generating speech for: "${text.substring(0, 50)}..."`);

            const response = await axios.post(
                `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`,
                {
                    text: text,
                    model_id: "eleven_monolingual_v1",
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75
                    }
                },
                {
                    headers: {
                        'xi-api-key': this.apiKey,
                        'Content-Type': 'application/json',
                        'Accept': 'audio/mpeg'
                    },
                    responseType: 'arraybuffer'
                }
            );

            console.log(`[TtsService] Generated ${response.data.length} bytes of audio.`);
            return Buffer.from(response.data);
        } catch (error: any) {
            console.error('[TtsService] ElevenLabs API Error:', error.response?.data ? Buffer.from(error.response.data).toString() : error.message);
            throw new Error(`TTS failed: ${error.message}`);
        }
    }
}

export const ttsService = new TtsService();
