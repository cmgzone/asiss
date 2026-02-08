import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

export class SttService {
    private apiKey: string | undefined;

    constructor() {
        this.apiKey = process.env.DEEPGRAM_API_KEY;
    }

    async transcribe(audioBuffer: Buffer, mimetype: string = 'audio/webm'): Promise<string> {
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
}

export const sttService = new SttService();
