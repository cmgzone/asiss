import { Skill } from '../core/skills';
import { Telegraf } from 'telegraf';

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
        },
        required: ['message'],
    };

    async execute(params: any): Promise<any> {
        const { message } = params;
        if (!message || typeof message !== 'string' || !message.trim()) {
            return { success: false, error: 'Message text is required.' };
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
            await bot.telegram.sendMessage(numericChatId, message.trim());
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
