/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByCodeLazy } from "@webpack";
import { FluxDispatcher, Menu } from "@webpack/common";

import { DesktopCaptureSource, MediaEngineSetGoLiveSourceEvent, RtcConnectionStateEvent, StreamCreateEvent, StreamSettings, StreamStartEvent, StreamStopEvent, StreamUpdateSettingsEvent } from "./types";

const Native = VencordNative.pluginHelpers.ShareActiveWindow as PluginNative<typeof import("./native")>;
const logger = new Logger("ShareActiveWindow");

let discordPid: number;
let discordWindowHandle: string;

let activeWindowInterval: NodeJS.Timeout | undefined;
let isSharingWindow: boolean = false;
let sharingSettings: StreamSettings = {};

let desktopCaptureSources: DesktopCaptureSource[] = [];
let sourceIdStack: string[] = [];

// Debug helper function to track Flux events
// Call it in plugin's start method
function patchFluxDispatcher(): void {
    const oldDispatch = FluxDispatcher.dispatch.bind(FluxDispatcher);
    const newDispatch = payload => {
        logger.debug("[Flux Event]", payload.type, payload);
        return oldDispatch(payload);
    };
    FluxDispatcher.dispatch = newDispatch;
}

const getDiscordUtils = (() => {
    let discordUtils: any;
    return (): {
        getWindowHandleFromPid(pid: number): string | undefined;
        getPidFromWindowHandle(handle: string): number | undefined;
    } => {
        if (discordUtils === undefined) {
            discordUtils = DiscordNative.nativeModules.requireModule("discord_utils");
        }
        return discordUtils;
    };
})();

const shareWindow: (
    source: DesktopCaptureSource,
    settings: StreamSettings,
) => void = findByCodeLazy(',"no permission"]');

const getDesktopCaptureSources: () => Promise<DesktopCaptureSource[]> = (() => {
    let result: Promise<DesktopCaptureSource[]> | undefined = undefined;

    return (): Promise<DesktopCaptureSource[]> => {
        const { desktopCapture }: {
            desktopCapture: {
                getDesktopCaptureSources(x: {
                    types: string[],
                    thumbnailSize: {
                        width: number;
                        height: number;
                    };
                }): Promise<DesktopCaptureSource[]>;
            };
        } = DiscordNative;

        if (result === undefined) {
            result = desktopCapture.getDesktopCaptureSources({
                types: ["window"],
                thumbnailSize: {
                    width: 0,
                    height: 0,
                },
            }).then(r => {
                result = undefined;
                return r;
            });
        }

        return result;
    };
})();

function stopSharingWindow(): void {
    isSharingWindow = false;
    sharingSettings = {};
    sourceIdStack = [];
    stopActiveWindowLoop();
}

function stopActiveWindowLoop(): void {
    if (activeWindowInterval !== undefined) {
        clearInterval(activeWindowInterval);
        activeWindowInterval = undefined;
    }
}

function initActiveWindowLoop(): void {
    // Do not init the loop if we don't share a window (e.g. share the entire screen)
    if (!isSharingWindow) {
        return;
    }

    // Ensure that at any given moment of time only a single interval callback function is executing
    let isIntervalCallbackRunning = false;

    activeWindowInterval = setInterval(async () => {
        if (isIntervalCallbackRunning) {
            return;
        }

        isIntervalCallbackRunning = true;

        try {
            if (!isSharingWindow) {
                return;
            }

            const activeWindow = await Native.getActiveWindow();
            if (activeWindow === undefined) {
                return;
            }

            const activeWindowHandle = getDiscordUtils().getWindowHandleFromPid(activeWindow.pid);
            if (activeWindowHandle === undefined) {
                return;
            }

            const newSourceId = `window:${activeWindowHandle}`;
            const curSourceId = sharingSettings.sourceId;

            if (curSourceId?.includes(newSourceId)) {
                return;
            }

            const { focusWindowTitles } = settings.store;
            const activeWindowPredicate = (source: DesktopCaptureSource) => {
                return (
                    source.id.includes(activeWindowHandle) || (
                        source.name === activeWindow.title &&
                        focusWindowTitles &&
                        focusWindowTitles.split(";").filter(
                            focusWindowTitle => !!focusWindowTitle
                        ).findIndex(
                            focusWindowTitle => source.name.toLowerCase().includes(
                                focusWindowTitle.toLowerCase()
                            )
                        ) !== -1
                    )
                );
            };

            // Try to find in the cache at first
            let activeWindowSource = desktopCaptureSources.find(activeWindowPredicate);

            // Additional check if the top one has failed
            // curSourceId?.includes(newSourceId)
            if (curSourceId && activeWindowSource?.id.includes(curSourceId)) {
                return;
            }

            if (activeWindowSource === undefined) {
                // Invalidate the cache
                desktopCaptureSources = await getDesktopCaptureSources();

                // Try to find again
                activeWindowSource = desktopCaptureSources.find(activeWindowPredicate);
                if (activeWindowSource === undefined) {
                    return;
                }
            }

            const { ignoreWindowTitles } = settings.store;
            if (ignoreWindowTitles) {
                const activeWindowSourceName = activeWindowSource.name.toLowerCase();
                const isIgnoreWindow = ignoreWindowTitles.split(";").filter(
                    ignoreWindowTitle => !!ignoreWindowTitle
                ).findIndex(
                    ignoreWindowTitle => activeWindowSourceName.includes(
                        ignoreWindowTitle.toLowerCase()
                    )
                ) !== -1;

                if (isIgnoreWindow) {
                    return;
                }
            }

            if (isSharingWindow) {
                sharingSettings.sourceId = newSourceId;

                // Prevent the source stack from growing too big
                // Remove unavailable (closed) sources from it
                const aliveSourceIds = sourceIdStack.filter(
                    sourceId => desktopCaptureSources.findIndex(
                        desktopCaptureSource => desktopCaptureSource.id.includes(sourceId)
                    ) !== -1
                );

                sourceIdStack = aliveSourceIds;
                sourceIdStack.push(newSourceId);

                shareWindow(activeWindowSource, sharingSettings);
            }
        }
        finally {
            isIntervalCallbackRunning = false;
        }
    }, settings.store.checkInterval);
}

const manageStreamsContextMenuPatch: NavContextMenuPatchCallback = (children): void => {
    const { isEnabled } = settings.use(["isEnabled"]);

    // Add checkbox only during window sharing mode
    if (!isSharingWindow) {
        return;
    }

    const mainGroup = findGroupChildrenByChildId("stream-settings-audio-enable", children);
    if (!mainGroup) {
        logger.debug("Failed to find manage-streams context menu");
        return;
    }

    mainGroup.push(
        <Menu.MenuCheckboxItem
            id="stream-settings-vc-saw-share-active-window"
            label="Share Active Window"
            checked={isEnabled}
            action={() => settings.store.isEnabled = !isEnabled}
        />
    );
};

const streamOptionsContextMenuPatch: NavContextMenuPatchCallback = (children): void => {
    const { isEnabled } = settings.use(["isEnabled"]);

    const mainGroup = findGroupChildrenByChildId("stream-option-mute", children);
    if (!mainGroup) {
        logger.debug("Failed to find stream-options context menu");
        return;
    }

    const shareActiveWindowCheckbox =
        <Menu.MenuCheckboxItem
            id="stream-option-vc-saw-share-active-window"
            label="Share active window"
            checked={isEnabled}
            action={() => settings.store.isEnabled = !isEnabled}
        />;

    const idx = mainGroup.findIndex(c => c?.props?.id === "stream-option-mute");
    if (idx !== -1) {
        mainGroup.splice(idx + 1, 0, shareActiveWindowCheckbox);
    } else {
        mainGroup.push(shareActiveWindowCheckbox);
    }
};

const settings = definePluginSettings({
    isEnabled: {
        description: "Enable active window monitoring",
        type: OptionType.BOOLEAN,
        default: true,
        hidden: true,
        onChange: (newValue: boolean): void => {
            stopActiveWindowLoop();
            if (newValue) {
                initActiveWindowLoop();
            }
        },
    },

    checkInterval: {
        description: "How often to check for active window, in milliseconds",
        type: OptionType.NUMBER,
        default: 1000,
        onChange: (_newValue?: number): void => {
            // Restart loop with a new check interval
            stopActiveWindowLoop();
            initActiveWindowLoop();
        },
        isValid: (value?: number) => {
            if (!value || value < 100) {
                return "Check Interval must be greater or equal to 100.";
            }
            return true;
        },
    },

    ignoreWindowTitles: {
        description: "A list of case-insensitive parts of a window title separated by semicolon ';'",
        type: OptionType.STRING,
        default: "Drag;"
    },

    focusWindowTitles: {
        description: "A list of case-insensitive parts of a window title separated by semicolon ';'",
        type: OptionType.STRING,
        default: "File Explorer;"
    },
});

export default definePlugin({
    name: "ShareActiveWindow",
    description: "Auto-switch to active window during screen sharing",
    authors: [Devs.ipasechnikov],
    settings,

    patches: [
        {
            find: "handleDesktopSourceEnded=(",
            replacement: {
                match: /(?<=handleDesktopSourceEnded\s*=\s*\([^)]*\)\s*=>\s*{)[^}]+(?=})/,
                replace: "if(!$self.handleDesktopSourceEnded()){$&;}",
            },
        },
    ],

    contextMenus: {
        "manage-streams": manageStreamsContextMenuPatch,
        "stream-options": streamOptionsContextMenuPatch,
    },

    flux: {
        STREAM_CREATE(event: StreamCreateEvent): void {
            sharingSettings.streamKey = event.streamKey;
        },

        STREAM_START(event: StreamStartEvent): void {
            isSharingWindow = event.sourceId.startsWith("window:");

            // No need to track active window if we are not sharing a window
            if (!isSharingWindow) {
                stopActiveWindowLoop();
                return;
            }

            if (!settings.store.isEnabled) {
                return;
            }

            if (event.analyticsLocations !== undefined) {
                sharingSettings.analyticsLocations = event.analyticsLocations;
            }

            if (event.audioSourceId !== undefined) {
                sharingSettings.audioSourceId = event.audioSourceId;
            }

            if (event.goLiveModalDurationMs !== undefined) {
                sharingSettings.goLiveModalDurationMs = event.goLiveModalDurationMs;
            }

            if (event.previewDisabled !== undefined) {
                sharingSettings.previewDisabled = event.previewDisabled;
            }

            if (event.sourceId !== undefined) {
                sharingSettings.sourceId = event.sourceId;
            }

            // Init loop if it is not running yet
            if (!activeWindowInterval) {
                initActiveWindowLoop();
            }
        },

        STREAM_STOP(event: StreamStopEvent): void {
            // Stop only for your own streams. Ignore other streams being stopped
            if (event.streamKey === sharingSettings.streamKey) {
                stopSharingWindow();
            }
        },

        STREAM_UPDATE_SETTINGS(event: StreamUpdateSettingsEvent): void {
            if (event.preset !== undefined) {
                sharingSettings.preset = event.preset;
            }

            if (event.frameRate !== undefined) {
                sharingSettings.fps = event.frameRate;
            }

            if (event.resolution !== undefined) {
                sharingSettings.resolution = event.resolution;
            }

            if (event.soundshareEnabled !== undefined) {
                sharingSettings.soundshareEnabled = event.soundshareEnabled;
            }
        },

        MEDIA_ENGINE_SET_GO_LIVE_SOURCE(event: MediaEngineSetGoLiveSourceEvent): void {
            const preset = event.settings?.qualityOptions?.preset;
            if (preset !== undefined) {
                sharingSettings.preset = preset;
            }

            const frameRate = event.settings?.qualityOptions?.frameRate;
            if (frameRate !== undefined) {
                sharingSettings.fps = frameRate;
            }

            const resolution = event.settings?.qualityOptions?.resolution;
            if (resolution !== undefined) {
                sharingSettings.resolution = resolution;
            }

            const sound = event.settings?.desktopSettings?.sound;
            if (sound !== undefined) {
                sharingSettings.soundshareEnabled = sound;
            }
        },

        RTC_CONNECTION_STATE(event: RtcConnectionStateEvent): void {
            // Stop only for your own streams. Ignore other streams being stopped
            if (event.state === "RTC_DISCONNECTED" && event.streamKey === sharingSettings.streamKey) {
                stopSharingWindow();
            }
        },
    },

    async start() {
        discordPid = await Native.getDiscordPid();
        discordWindowHandle = getDiscordUtils().getWindowHandleFromPid(discordPid)!;

        // For debug and development purposes only
        // patchFluxDispatcher();

        await Native.initActiveWindow();
        initActiveWindowLoop();
    },

    stop() {
        stopSharingWindow();
    },

    handleDesktopSourceEnded(): boolean {
        // Prevent potential infinite loops
        const maxRetries: number = 1000;
        for (let retry = 0; retry < maxRetries; retry++) {
            let prevSourceId = sourceIdStack.pop();
            if (prevSourceId === undefined) {
                // Fallback to Discord window
                const discordSourceId = `window:${discordWindowHandle}`;
                prevSourceId = discordSourceId;
            }

            const prevCaptureSource = desktopCaptureSources.find(
                source => source.id.includes(prevSourceId)
            );

            if (prevCaptureSource === undefined) {
                continue;
            }

            sharingSettings.sourceId = prevSourceId;
            shareWindow(prevCaptureSource, sharingSettings);

            return true;
        }

        return false;
    },
});
