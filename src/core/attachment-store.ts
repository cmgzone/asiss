import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface StoredModelAttachment {
  type: 'image';
  mimeType: string;
  dataUrl: string;
  name?: string;
}

interface StoredAttachment {
  id: string;
  ownerId: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  url: string;
  createdAt: number;
}

class AttachmentStore {
  private readonly root = path.join(process.cwd(), 'artifacts', 'attachments');
  private readonly records = new Map<string, StoredAttachment>();
  private readonly allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

  constructor() {
    fs.mkdirSync(this.root, { recursive: true });
  }

  put(ownerId: string, file: { originalname: string; mimetype: string; size: number; buffer: Buffer }): Omit<StoredAttachment, 'path' | 'ownerId'> {
    if (!this.allowed.has(file.mimetype)) throw new Error(`Unsupported image type: ${file.mimetype}`);
    if (file.size <= 0 || file.size > 8 * 1024 * 1024) throw new Error('Images must be between 1 byte and 8 MB.');
    const id = `att_${crypto.randomBytes(12).toString('hex')}`;
    const ext = file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : file.mimetype === 'image/gif' ? '.gif' : '.jpg';
    const filePath = path.join(this.root, `${id}${ext}`);
    fs.writeFileSync(filePath, file.buffer, { flag: 'wx' });
    const record: StoredAttachment = {
      id, ownerId, name: path.basename(file.originalname || `image${ext}`).slice(0, 180),
      mimeType: file.mimetype, size: file.size, path: filePath,
      url: `/api/artifacts/attachments/${path.basename(filePath)}`, createdAt: Date.now()
    };
    this.records.set(id, record);
    const { path: _path, ownerId: _ownerId, ...safe } = record;
    return safe;
  }

  resolveMany(ids: unknown, ownerId: string): StoredModelAttachment[] {
    if (!Array.isArray(ids)) return [];
    return ids.slice(0, 4)
      .map(raw => this.records.get(String(raw)))
      .filter((item): item is StoredAttachment => Boolean(item && item.ownerId === ownerId))
      .map(item => ({
        type: 'image', mimeType: item.mimeType, name: item.name,
        dataUrl: `data:${item.mimeType};base64,${fs.readFileSync(item.path).toString('base64')}`
      }));
  }
}

export const attachmentStore = new AttachmentStore();
