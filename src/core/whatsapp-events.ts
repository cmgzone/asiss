import { EventEmitter } from 'events';

export type WhatsAppStatus =
  | 'idle'
  | 'starting'
  | 'qr'
  | 'ready'
  | 'authenticated'
  | 'disconnected'
  | 'auth_failure';

export interface WhatsAppStatusPayload {
  status: WhatsAppStatus;
  message?: string;
}

class WhatsAppEventBus extends EventEmitter {
  private lastQr: string | null = null;
  private lastStatus: WhatsAppStatusPayload = { status: 'idle' };

  setQr(qr: string) {
    this.lastQr = qr;
    this.lastStatus = { status: 'qr' };
    this.emit('qr', qr);
    this.emit('status', this.lastStatus);
  }

  setStatus(status: WhatsAppStatus, message?: string) {
    this.lastStatus = { status, message };
    if (status !== 'qr') {
      this.lastQr = null;
    }
    this.emit('status', this.lastStatus);
  }

  getLastQr(): string | null {
    return this.lastQr;
  }

  getLastStatus(): WhatsAppStatusPayload {
    return this.lastStatus;
  }
}

export const whatsappEvents = new WhatsAppEventBus();
