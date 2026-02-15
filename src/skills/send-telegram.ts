import { Skill } from '../core/skills';
import { Telegraf } from 'telegraf';
import fs from 'fs';
import { trustedActions } from '../core/trusted-actions';

export class SendTelegramSkill implements Skill {
    name = 'send_telegram';
    description =
        'Send a message to the owner/user on Telegram. Use this when the user asks you to notify them, forward findings, or send results to their Telegram.';
    inputSchema = {
        type: 'object',
        properties: {
            message: {
                type: 'string',
                description:
                    'The message text to send to the user on Telegram. Supports plain text and basic markdown.',
            },
            imagePath: {
                type: 'string',
                description: 'Local image file path to send as a photo.'
            },
            imageUrl: {
                type: 'string',
                description: 'Image URL to send as a photo.'
            },
            caption: {
                type: 'string',
                description: 'Optional caption for the image.'
            }
        },
        required: [],
    };

    async execute(params: any): Promise<any> {
        const { message, imagePath, imageUrl, caption } = params;
        const sessionId = params?.__sessionId;
        const text = typeof message === 'string' ? message.trim() : '';
        const hasImagePath = typeof imagePath === 'string' && imagePath.trim().length > 0;
        const hasImageUrl = typeof imageUrl === 'string' && imageUrl.trim().length > 0;
        if (!text && !hasImagePath && !hasImageUrl) {
            return { success: false, error: 'Provide message or imagePath/imageUrl.' };
        }

        if (!trustedActions.isAllowed('send_telegram')) {
            return {
                success: false,
                error: 'Trusted action "send_telegram" is not allowed. Enable it in config.json trustedActions.allow.',
            };
        }

        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) {
            return {
                success: false,
                error:
                    'TELEGRAM_BOT_TOKEN is not set in .env. Cannot send Telegram messages.',
            };
        }

        const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
        if (!chatId) {
            return {
                success: false,
                error:
                    'TELEGRAM_OWNER_CHAT_ID is not set in .env. The user needs to add their Telegram chat ID to the .env file. They can get it by messaging @userinfobot on Telegram.',
            };
        }

        try {
            const bot = new Telegraf(botToken);
            const numericChatId = /^\d+$/.test(chatId) ? Number(chatId) : chatId;
            if (hasImagePath || hasImageUrl) {
                const cap = typeof caption === 'string' && caption.trim() ? caption.trim() : (text || undefined);
                if (hasImagePath) {
                    const filePath = imagePath.trim();
                    if (!fs.existsSync(filePath)) {
                        return { success: false, error: `Image not found at ${filePath}` };
                    }
                    await bot.telegram.sendPhoto(numericChatId, { source: filePath }, cap ? { caption: cap } : undefined);
                    trustedActions.logRequest({
                        action: 'send_telegram',
                        sessionId,
                        payload: { chatId: numericChatId, imagePath: filePath, caption: cap },
                        createdAt: Date.now()
                    });
                } else if (hasImageUrl) {
                    const url = imageUrl.trim();
                    await bot.telegram.sendPhoto(numericChatId, url, cap ? { caption: cap } : undefined);
                    trustedActions.logRequest({
                        action: 'send_telegram',
                        sessionId,
                        payload: { chatId: numericChatId, imageUrl: url, caption: cap },
                        createdAt: Date.now()
                    });
                }
                if (text && !cap) {
                    await bot.telegram.sendMessage(numericChatId, text);
                }
            } else if (text) {
                await bot.telegram.sendMessage(numericChatId, text);
                trustedActions.logRequest({
                    action: 'send_telegram',
                    sessionId,
                    payload: { chatId: numericChatId, message: text },
                    createdAt: Date.now()
                });
            }
            return {
                success: true,
                message: `Message sent to Telegram (chat ${chatId}).`,
            };
        } catch (err: any) {
            return {
                success: false,
                error: `Failed to send Telegram message: ${err.message || err}`,
            };
        }
    }
}
