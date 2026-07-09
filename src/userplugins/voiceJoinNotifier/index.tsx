/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { showNotification } from "@api/Notifications";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, SelectedChannelStore, UserStore } from "@webpack/common";

interface VoiceStateChangeEvent {
    userId: string;
    channelId?: string;
    oldChannelId?: string;
    deaf: boolean;
    mute: boolean;
    selfDeaf: boolean;
    selfMute: boolean;
    sessionId: string;
}

const settings = definePluginSettings({
    telegramBotToken: {
        description: "Telegram bot token for push notifications",
        type: OptionType.STRING,
        default: "",
        placeholder: "123456:ABCdef...",
    },
    telegramChatId: {
        description: "Telegram chat ID to send notifications to",
        type: OptionType.STRING,
        default: "",
        placeholder: "1234567890",
    },
    notifyOwnJoins: {
        description: "Notify when you join a voice channel yourself",
        type: OptionType.BOOLEAN,
        default: false,
    },
});

function sendTelegramNotification(displayName: string, channelName: string) {
    const token = settings.store.telegramBotToken;
    const chatId = settings.store.telegramChatId;
    if (!token || !chatId) return;

    const text = `🔊 <b>${escapeHtml(displayName)}</b> joined <b>${escapeHtml(channelName)}</b>`;

    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: "HTML",
        }),
    }).catch(() => {});
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export default definePlugin({
    name: "VoiceJoinNotifier",
    description: "Shows a notification when someone joins your voice channel, with optional Telegram push",
    authors: [{ name: "Ilia Pasechnikov", id: 0n }],
    settings,

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceStateChangeEvent[]; }) {
            const myChannelId = SelectedChannelStore.getVoiceChannelId();
            if (!myChannelId) return;

            for (const state of voiceStates) {
                const { userId, channelId, oldChannelId } = state;
                const myId = UserStore.getCurrentUser().id;

                if (userId === myId && !settings.store.notifyOwnJoins) continue;

                // Someone joined our channel (was not in it, now is)
                if (channelId === myChannelId && oldChannelId !== myChannelId) {
                    const user = UserStore.getUser(userId);
                    if (!user) continue;

                    const displayName = (user as any).globalName ?? user.username;
                    const channelName = ChannelStore.getChannel(myChannelId)?.name ?? "Unknown";

                    showNotification({
                        title: `🔊 ${displayName}`,
                        body: `Joined ${channelName}`,
                        icon: user.getAvatarURL(undefined, 80, false),
                    });

                    sendTelegramNotification(displayName, channelName);
                }
            }
        },
    },
});