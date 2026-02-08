export interface Message {
  id: string;
  channel: string;
  senderId: string;
  content: string;
  timestamp: number;
  metadata?: any;
}

export interface Session {
  id: string;
  userId: string;
  channel: string;
  context: Message[];
}

export interface ChannelAdapter {
  name: string;
  start(): void;
  send(userId: string, text: string): void;
  sendStream?(userId: string, chunk: string): void; // New method for streaming
  onMessage(handler: (msg: Message) => void): void;
}
