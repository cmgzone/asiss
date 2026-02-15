import { Skill } from '../core/skills';
import { trustedActions } from '../core/trusted-actions';
import * as nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';

type EmailConfig = {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
};

const loadEmailConfig = (): EmailConfig => {
  const cfgPath = path.join(process.cwd(), 'config.json');
  let cfg: any = {};
  if (fs.existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    } catch {
      cfg = {};
    }
  }
  const emailCfg = cfg?.email || {};
  return {
    host: process.env.SMTP_HOST || emailCfg.host,
    port: Number(process.env.SMTP_PORT || emailCfg.port || 0) || undefined,
    secure: (process.env.SMTP_SECURE || emailCfg.secure) === true || String(process.env.SMTP_SECURE).toLowerCase() === 'true',
    user: process.env.SMTP_USER || emailCfg.user,
    pass: process.env.SMTP_PASS || emailCfg.pass,
    from: process.env.SMTP_FROM || emailCfg.from
  };
};

export class SendEmailSkill implements Skill {
  name = 'send_email';
  description = 'Send an email via SMTP. Requires trustedActions allowlist and SMTP config.';
  inputSchema = {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address' },
      subject: { type: 'string', description: 'Email subject' },
      text: { type: 'string', description: 'Plain text body' },
      html: { type: 'string', description: 'HTML body (optional)' }
    },
    required: ['to', 'subject', 'text']
  };

  async execute(params: any): Promise<any> {
    const sessionId = params?.__sessionId;
    if (!trustedActions.isAllowed('send_email')) {
      return { success: false, error: 'Trusted action "send_email" is not allowed. Enable it in config.json trustedActions.allow.' };
    }

    const to = String(params?.to || '').trim();
    const subject = String(params?.subject || '').trim();
    const text = String(params?.text || '').trim();
    const html = params?.html ? String(params.html) : undefined;

    if (!to || !subject || !text) {
      return { success: false, error: 'to, subject, and text are required.' };
    }

    const cfg = loadEmailConfig();
    if (!cfg.host || !cfg.user || !cfg.pass || !cfg.from) {
      return {
        success: false,
        error: 'SMTP config missing. Set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM (and optional SMTP_PORT/SMTP_SECURE) or config.json email.*'
      };
    }

    try {
      const transporter = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port || 587,
        secure: Boolean(cfg.secure),
        auth: {
          user: cfg.user,
          pass: cfg.pass
        }
      });

      const info = await transporter.sendMail({
        from: cfg.from,
        to,
        subject,
        text,
        html
      });

      trustedActions.logRequest({
        action: 'send_email',
        sessionId,
        payload: { to, subject, messageId: info.messageId },
        createdAt: Date.now()
      });

      return { success: true, messageId: info.messageId };
    } catch (err: any) {
      return { success: false, error: `Failed to send email: ${err.message || err}` };
    }
  }
}
