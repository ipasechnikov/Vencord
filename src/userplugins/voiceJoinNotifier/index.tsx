/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import {
    ChannelStore,
    GuildStore,
    SelectedChannelStore,
    UserStore,
    VoiceStateStore,
} from "@webpack/common";

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

const logger = new Logger("VoiceJoinNotifier");

const settings = definePluginSettings({
    telegramBotToken: {
        description: "Telegram bot token for push notifications",
        type: OptionType.STRING,
        default: "",
        placeholder: "123456:ABCdef...",
        // Vencord has no isSecret flag for string settings, so mask the input via the underlying TextInput's "password" type.
        componentProps: { type: "password" },
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

function escapeHtml(str: string): string {
    // Telegram's HTML parse_mode only requires escaping &, < and >; it has no attribute syntax, so quotes don't support escaping.
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildJoinCaption(
    displayName: string,
    channelName: string,
    guildName: string | undefined,
): string {
    const guildPart = guildName ? ` in <b>${escapeHtml(guildName)}</b>` : "";
    return `🔊 <b>${escapeHtml(displayName)}</b> joined <b>${escapeHtml(channelName)}</b>${guildPart}`;
}

interface TelegramJob {
    endpoint: "sendMessage" | "sendPhoto";
    payload: Record<string, unknown>;
}

// Telegram enforces roughly one message per second per chat, so sends are queued and drained at this pace; 429 retry_after is honored.
const TELEGRAM_SEND_INTERVAL_MS = 1100;

const telegramQueue: TelegramJob[] = [];
let isProcessingTelegramQueue = false;

function queueTelegramSend(job: TelegramJob) {
    telegramQueue.push(job);
    if (!isProcessingTelegramQueue) processTelegramQueue();
}

// Sends the job at the front of the queue. Returns a retry delay in ms when rate-limited, or null to move on.
async function sendTelegramJob(job: TelegramJob): Promise<number | null> {
    const token = settings.store.telegramBotToken;
    const chatId = settings.store.telegramChatId;
    if (!token || !chatId) return null;

    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/${job.endpoint}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                ...job.payload,
            }),
        });

        if (res.status === 429) {
            const body = await res.json().catch(() => null);
            const retryAfterSec = body?.parameters?.retry_after ?? 1;
            logger.warn(`Telegram rate limited, retrying ${job.endpoint} in ${retryAfterSec}s`);
            return retryAfterSec * 1000;
        }

        if (!res.ok) {
            logger.error(`Telegram ${job.endpoint} failed:`, res.status, res.statusText);
        }
    } catch (err) {
        logger.error(`Telegram ${job.endpoint} error:`, err);
    }

    return null;
}

async function processTelegramQueue() {
    isProcessingTelegramQueue = true;

    while (telegramQueue.length > 0) {
        const job = telegramQueue[0];
        const retryAfterMs = await sendTelegramJob(job);

        if (retryAfterMs !== null) {
            await sleep(retryAfterMs);
            continue;
        }

        telegramQueue.shift();
        if (telegramQueue.length > 0) await sleep(TELEGRAM_SEND_INTERVAL_MS);
    }

    isProcessingTelegramQueue = false;
}

function sendTelegramNotification(user: User, channelName: string, guildName: string | undefined) {
    if (!settings.store.telegramBotToken || !settings.store.telegramChatId) return;

    const text = buildJoinCaption(user.globalName ?? user.username, channelName, guildName);

    if (user.avatar !== null) {
        queueTelegramSend({
            endpoint: "sendPhoto",
            payload: {
                photo: user.getAvatarURL(undefined, 128, false),
                caption: text,
                parse_mode: "HTML",
            },
        });
    } else {
        queueTelegramSend({ endpoint: "sendMessage", payload: { text, parse_mode: "HTML" } });
    }
}

// Module-level state is safe only because Vencord instantiates this plugin once; concurrent instances would need per-instance state.
const notifiedUsers = new Set<string>();
let currentChannelId: string | null = null;

// Adds users already present in the channel so enabling or joining doesn't fire a burst of notifications.
function prepopulateNotifiedUsers(channelId: string, excludeIds?: Set<string>) {
    const myId = UserStore.getCurrentUser().id;
    const states = VoiceStateStore.getVoiceStatesForChannel(channelId) as Record<
        string,
        VoiceStateChangeEvent
    >;
    for (const userId of Object.keys(states)) {
        if (userId !== myId && !excludeIds?.has(userId)) {
            notifiedUsers.add(userId);
        }
    }
}

export default definePlugin({
    name: "VoiceJoinNotifier",
    description:
        "Shows a notification when someone joins your voice channel, with optional Telegram push",
    authors: [{ name: "Ilia Pasechnikov", id: 0n }],
    settings,

    start() {
        // Pre-populate with users already in the channel to avoid notification burst on enable
        const channelId = SelectedChannelStore.getVoiceChannelId();
        if (channelId) {
            currentChannelId = channelId;
            prepopulateNotifiedUsers(channelId);
        }
    },

    stop() {
        notifiedUsers.clear();
        currentChannelId = null;
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceStateChangeEvent[] }) {
            const myChannelId = SelectedChannelStore.getVoiceChannelId();
            if (!myChannelId) {
                // Fully disconnected from voice — reset so reconnecting to the same channel isn't blocked by stale entries
                notifiedUsers.clear();
                currentChannelId = null;
                return;
            }

            const channel = ChannelStore.getChannel(myChannelId);
            const guildName = channel?.guild_id
                ? GuildStore.getGuild(channel.guild_id)?.name
                : undefined;

            // If we switched channels, reset the tracked set
            if (myChannelId !== currentChannelId) {
                notifiedUsers.clear();
                currentChannelId = myChannelId;
            }

            const myId = UserStore.getCurrentUser().id;

            // We're joining a channel with users already in it: pre-populate them to avoid a burst
            // from the initial state sync, excluding this batch's joiners so their join still notifies below.
            const myState = voiceStates.find(s => s.userId === myId);
            if (myState && myState.channelId === myChannelId) {
                prepopulateNotifiedUsers(myChannelId, new Set(voiceStates.map(s => s.userId)));
            }

            for (const state of voiceStates) {
                const { userId, channelId } = state;

                if (userId === myId && !settings.store.notifyOwnJoins) continue;

                // Someone joined our channel and we haven't notified for them yet
                if (channelId === myChannelId && !notifiedUsers.has(userId)) {
                    notifiedUsers.add(userId);
                    const user = UserStore.getUser(userId);
                    if (!user) continue;

                    const displayName = user.globalName ?? user.username;
                    const channelName = channel?.name ?? "Unknown";
                    const titlePrefix = guildName ? `${guildName} — ` : "";

                    showNotification({
                        title: `🔊 ${displayName}`,
                        body: `${titlePrefix}Joined ${channelName}`,
                        icon: user.getAvatarURL(undefined, 80, false),
                    });

                    sendTelegramNotification(user, channelName, guildName);
                }

                // User left our channel — allow re-notification if they join again
                if (channelId !== myChannelId && notifiedUsers.has(userId)) {
                    notifiedUsers.delete(userId);
                }
            }
        },
    },
});
