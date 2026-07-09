/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { showNotification } from "@api/Notifications";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, GuildStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";

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

function sendTelegramNotification(
    displayName: string,
    channelName: string,
    guildName: string | undefined,
    avatarUrl: string,
) {
    const token = settings.store.telegramBotToken;
    const chatId = settings.store.telegramChatId;
    if (!token || !chatId) return;

    const guildPart = guildName ? ` in <b>${escapeHtml(guildName)}</b>` : "";
    const caption = `🔊 <b>${escapeHtml(displayName)}</b> joined <b>${escapeHtml(channelName)}</b>${guildPart}`;

    fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            photo: avatarUrl,
            caption,
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

// Track users we've already notified for in the current channel.
// Reset when switching channels to avoid false positives on reconnect.
let notifiedUsers = new Set<string>();
let currentChannelId: string | null = null;

export default definePlugin({
    name: "VoiceJoinNotifier",
    description: "Shows a notification when someone joins your voice channel, with optional Telegram push",
    authors: [{ name: "Ilia Pasechnikov", id: 0n }],
    settings,

    start() {
        // Pre-populate with users already in the channel to avoid notification burst on enable
        const channelId = SelectedChannelStore.getVoiceChannelId();
        if (channelId) {
            currentChannelId = channelId;
            const states = VoiceStateStore.getVoiceStatesForChannel(channelId) as Record<string, VoiceStateChangeEvent>;
            for (const userId of Object.keys(states)) {
                notifiedUsers.add(userId);
            }
        }
    },

    stop() {
        notifiedUsers.clear();
        currentChannelId = null;
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceStateChangeEvent[]; }) {
            const myChannelId = SelectedChannelStore.getVoiceChannelId();
            if (!myChannelId) return;

            const channel = ChannelStore.getChannel(myChannelId);
            const guildName = channel?.guild_id
                ? GuildStore.getGuild(channel.guild_id)?.name
                : undefined;

            // If we switched channels, reset the tracked set
            if (myChannelId !== currentChannelId) {
                notifiedUsers.clear();
                currentChannelId = myChannelId;
            }

            for (const state of voiceStates) {
                const { userId, channelId } = state;
                const myId = UserStore.getCurrentUser().id;

                if (userId === myId && !settings.store.notifyOwnJoins) continue;

                // Someone joined our channel and we haven't notified for them yet
                if (channelId === myChannelId && !notifiedUsers.has(userId)) {
                    notifiedUsers.add(userId);
                    const user = UserStore.getUser(userId);
                    if (!user) continue;

                    const displayName = (user as any).globalName ?? user.username;
                    const channelName = channel?.name ?? "Unknown";
                    const titlePrefix = guildName ? `${guildName} — ` : "";

                    showNotification({
                        title: `🔊 ${displayName}`,
                        body: `${titlePrefix}Joined ${channelName}`,
                        icon: user.getAvatarURL(undefined, 80, false),
                    });

                    sendTelegramNotification(
                        displayName,
                        channelName,
                        guildName,
                        user.getAvatarURL(undefined, 128, false),
                    );
                }

                // User left our channel — allow re-notification if they join again
                if (channelId !== myChannelId && notifiedUsers.has(userId)) {
                    notifiedUsers.delete(userId);
                }
            }
        },
    },
});