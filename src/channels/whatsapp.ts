import { ChannelAdapter, Message } from '../core/types';
import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

export class WhatsAppChannel implements ChannelAdapter {
  name = 'whatsapp';
  private client: Client;
  private handler: ((msg: Message) => void) | null = null;
  private isStarted = false;

  constructor() {
    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
      puppeteer: {
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    });

    this.client.on('qr', (qr) => {
      console.log('[WhatsAppChannel] QR Code received. Scan it with your phone:');
      qrcode.generate(qr, { small: true });
    });

    this.client.on('ready', () => {
      console.log('[WhatsAppChannel] Client is ready!');
      this.isStarted = true;
    });

    this.client.on('message', (message) => {
        if (this.handler) {
            const msg: Message = {
              id: message.id.id,
              channel: 'whatsapp',
              senderId: message.from, // e.g., 1234567890@c.us
              content: message.body,
              timestamp: message.timestamp * 1000,
              metadata: {
                  isGroup: message.from.includes('@g.us'),
                  notifyName: (message as any)._data?.notifyName
              }
            };
            this.handler(msg);
        }
    });
  }

  async start() {
    if (!this.isStarted) {
      console.log('[WhatsAppChannel] Initializing...');
      try {
        await this.client.initialize();
      } catch (err) {
        console.error('[WhatsAppChannel] Failed to initialize:', err);
      }
    }
  }

  async send(userId: string, text: string) {
    try {
        // userId is the chat ID (e.g. 12345@c.us)
        await this.client.sendMessage(userId, text);
    } catch (err) {
      console.error(`[WhatsAppChannel] Failed to send message to ${userId}:`, err);
    }
  }

  onMessage(handler: (msg: Message) => void) {
    this.handler = handler;
  }
}
