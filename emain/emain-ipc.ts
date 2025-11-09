// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as electron from "electron";
import { FastAverageColor } from "fast-average-color";
import fs from "fs";
import type { IPty } from "node-pty";
import * as child_process from "node:child_process";
import { createRequire } from "node:module";
import os from "os";
import * as path from "path";
import { PNG } from "pngjs";
import { Readable } from "stream";
import { RpcApi } from "../frontend/app/store/wshclientapi";
import { getWebServerEndpoint } from "../frontend/util/endpoints";
import * as keyutil from "../frontend/util/keyutil";
import { fireAndForget, parseDataUrl } from "../frontend/util/util";
import { incrementTermCommandsRun } from "./emain-activity";
import { createBuilderWindow, getBuilderWindowByWebContentsId } from "./emain-builder";
import {
    callWithOriginalXdgCurrentDesktop,
    callWithOriginalXdgCurrentDesktopAsync,
    unamePlatform,
} from "./emain-platform";
import { getWaveTabViewByWebContentsId } from "./emain-tabview";
import { handleCtrlShiftState } from "./emain-util";
import { getWaveVersion } from "./emain-wavesrv";
import { createNewWaveWindow, focusedWaveWindow, getWaveWindowByWebContentsId } from "./emain-window";
import { ElectronWshClient } from "./emain-wsh";

const electronApp = electron.app;
const requireForMain = createRequire(import.meta.url);
const nodePtyModule = requireForMain("node-pty") as typeof import("node-pty");
const { spawn: spawnPty } = nodePtyModule;

let webviewFocusId: number = null;
let webviewKeys: string[] = [];

type NeovimSession = {
    pty: IPty;
    tempFile: string;
    tempDir: string;
    watcher: fs.FSWatcher;
    webContentsId: number;
    readTimer?: NodeJS.Timeout;
};

const neovimSessions = new Map<string, NeovimSession>();

function sendToWebContents(webContentsId: number, channel: string, payload: any) {
    const target = electron.webContents.fromId(webContentsId);
    if (!target || target.isDestroyed()) {
        return;
    }
    target.send(channel, payload);
}

async function readFileSafe(filePath: string): Promise<string> {
    try {
        const data = await fs.promises.readFile(filePath, "utf8");
        return data;
    } catch (err) {
        console.error("Failed to read Neovim temp file", filePath, err);
        return null;
    }
}

function cleanupNeovimSession(
    sessionId: string,
    sendExitEvent = false,
    exitPayload: { code?: number; signal?: number } = {}
) {
    const session = neovimSessions.get(sessionId);
    if (!session) {
        return;
    }
    if (session.readTimer) {
        clearTimeout(session.readTimer);
    }
    try {
        session.watcher?.close();
    } catch (err) {
        console.warn("Error closing Neovim watcher", err);
    }
    try {
        session.pty?.kill();
    } catch (err) {
        console.warn("Error killing Neovim PTY", err);
    }
    fs.promises
        .rm(session.tempDir, { recursive: true, force: true })
        .catch((err) => console.warn("Error removing Neovim temp dir", session.tempDir, err));
    neovimSessions.delete(sessionId);
    if (sendExitEvent) {
        sendToWebContents(session.webContentsId, "neovim-exit", {
            sessionId,
            code: exitPayload.code ?? null,
            signal: exitPayload.signal ?? null,
        });
    }
}

function expandHomePath(filePath: string): string {
    if (typeof filePath !== "string" || filePath.length === 0) {
        return filePath;
    }
    if (filePath === "~") {
        return electronApp.getPath("home");
    }
    if (filePath.startsWith("~/")) {
        return path.join(electronApp.getPath("home"), filePath.slice(2));
    }
    return filePath;
}

function openFileWithCursor(filePath: string) {
    if (typeof filePath !== "string" || filePath.length === 0) {
        return;
    }
    const expandedPath = expandHomePath(filePath);
    const fallbackOpen = () => {
        fireAndForget(() =>
            callWithOriginalXdgCurrentDesktopAsync(async () => {
                const excuse = await electron.shell.openPath(expandedPath);
                if (excuse) {
                    console.error(`Failed to open ${expandedPath} in native application: ${excuse}`);
                }
            })
        );
    };

    const platform = process.platform;
    try {
        if (platform === "darwin") {
            const proc = child_process.spawn("/usr/bin/open", ["-a", "Cursor", expandedPath], {
                detached: true,
                stdio: "ignore",
            });
            proc.on("error", (err) => {
                console.error("Failed to launch Cursor via open -a:", err);
                fallbackOpen();
            });
            proc.unref();
            return;
        }

        if (platform === "win32") {
            const proc = child_process.spawn("cursor.exe", [expandedPath], {
                detached: true,
                stdio: "ignore",
                windowsHide: true,
            });
            proc.on("error", (err) => {
                console.error("Failed to launch cursor.exe:", err);
                fallbackOpen();
            });
            proc.unref();
            return;
        }

        callWithOriginalXdgCurrentDesktop(() => {
            const proc = child_process.spawn("cursor", [expandedPath], { detached: true, stdio: "ignore" });
            proc.on("error", (err) => {
                console.error("Failed to launch cursor CLI:", err);
                fallbackOpen();
            });
            proc.unref();
        });
    } catch (err) {
        console.error("Unexpected error launching Cursor:", err);
        fallbackOpen();
    }
}

type UrlInSessionResult = {
    stream: Readable;
    mimeType: string;
    fileName: string;
};

function getSingleHeaderVal(headers: Record<string, string | string[]>, key: string): string {
    const val = headers[key];
    if (val == null) {
        return null;
    }
    if (Array.isArray(val)) {
        return val[0];
    }
    return val;
}

function cleanMimeType(mimeType: string): string {
    if (mimeType == null) {
        return null;
    }
    const parts = mimeType.split(";");
    return parts[0].trim();
}

function getFileNameFromUrl(url: string): string {
    try {
        const pathname = new URL(url).pathname;
        const filename = pathname.substring(pathname.lastIndexOf("/") + 1);
        return filename;
    } catch (e) {
        return null;
    }
}

function getUrlInSession(session: Electron.Session, url: string): Promise<UrlInSessionResult> {
    return new Promise((resolve, reject) => {
        if (url.startsWith("data:")) {
            try {
                const parsed = parseDataUrl(url);
                const buffer = Buffer.from(parsed.buffer);
                const readable = Readable.from(buffer);
                resolve({ stream: readable, mimeType: parsed.mimeType, fileName: "image" });
            } catch (err) {
                return reject(err);
            }
            return;
        }
        const request = electron.net.request({
            url,
            method: "GET",
            session,
        });
        const readable = new Readable({
            read() {},
        });
        request.on("response", (response) => {
            const statusCode = response.statusCode;
            if (statusCode < 200 || statusCode >= 300) {
                readable.destroy();
                request.abort();
                reject(new Error(`HTTP request failed with status ${statusCode}: ${response.statusMessage || ""}`));
                return;
            }

            const mimeType = cleanMimeType(getSingleHeaderVal(response.headers, "content-type"));
            const fileName = getFileNameFromUrl(url) || "image";
            response.on("data", (chunk) => {
                readable.push(chunk);
            });
            response.on("end", () => {
                readable.push(null);
                resolve({ stream: readable, mimeType, fileName });
            });
            response.on("error", (err) => {
                readable.destroy(err);
                reject(err);
            });
        });
        request.on("error", (err) => {
            readable.destroy(err);
            reject(err);
        });
        request.end();
    });
}

function saveImageFileWithNativeDialog(defaultFileName: string, mimeType: string, readStream: Readable) {
    if (defaultFileName == null || defaultFileName == "") {
        defaultFileName = "image";
    }
    const ww = focusedWaveWindow;
    if (ww == null) {
        return;
    }
    const mimeToExtension: { [key: string]: string } = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/bmp": "bmp",
        "image/tiff": "tiff",
        "image/heic": "heic",
        "image/svg+xml": "svg",
    };
    function addExtensionIfNeeded(fileName: string, mimeType: string): string {
        const extension = mimeToExtension[mimeType];
        if (!path.extname(fileName) && extension) {
            return `${fileName}.${extension}`;
        }
        return fileName;
    }
    defaultFileName = addExtensionIfNeeded(defaultFileName, mimeType);
    electron.dialog
        .showSaveDialog(ww, {
            title: "Save Image",
            defaultPath: defaultFileName,
            filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "heic"] }],
        })
        .then((file) => {
            if (file.canceled) {
                return;
            }
            const writeStream = fs.createWriteStream(file.filePath);
            readStream.pipe(writeStream);
            writeStream.on("finish", () => {
                console.log("saved file", file.filePath);
            });
            writeStream.on("error", (err) => {
                console.log("error saving file (writeStream)", err);
                readStream.destroy();
            });
            readStream.on("error", (err) => {
                console.error("error saving file (readStream)", err);
                writeStream.destroy();
            });
        })
        .catch((err) => {
            console.log("error trying to save file", err);
        });
}

export function initIpcHandlers() {
    electron.ipcMain.handle(
        "neovim-start",
        async (
            event,
            options: {
                sessionId: string;
                displayName: string;
                initialContent: string;
                cols: number;
                rows: number;
            }
        ) => {
            const { sessionId, displayName, initialContent, cols, rows } = options ?? {};
            if (!sessionId) {
                throw new Error("neovim-start missing sessionId");
            }
            // Clean up any existing session with the same id.
            cleanupNeovimSession(sessionId);

            const safeNameBase = path.basename(displayName || "") || "buffer";
            const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "waveterm-nvim-"));
            const tempFile = path.join(tempDir, safeNameBase);
            await fs.promises.writeFile(tempFile, initialContent ?? "", "utf8");

            const termCols = Math.max(1, Math.floor(cols ?? 80));
            const termRows = Math.max(1, Math.floor(rows ?? 24));

            let ptyProcess: IPty;
            try {
                ptyProcess = spawnPty("nvim", [tempFile], {
                    name: "xterm-256color",
                    cols: termCols,
                    rows: termRows,
                    cwd: process.cwd(),
                    env: {
                        ...process.env,
                        TERM: "xterm-256color",
                    },
                });
            } catch (err) {
                await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
                throw err;
            }

            const webContentsId = event.sender.id;
            const session: NeovimSession = {
                pty: ptyProcess,
                tempFile,
                tempDir,
                watcher: null,
                webContentsId,
            };

            const scheduleFileEmit = () => {
                if (session.readTimer) {
                    clearTimeout(session.readTimer);
                }
                session.readTimer = setTimeout(async () => {
                    const content = await readFileSafe(tempFile);
                    if (content != null) {
                        sendToWebContents(webContentsId, "neovim-file-change", {
                            sessionId,
                            content,
                        });
                    }
                }, 75);
            };

            try {
                session.watcher = fs.watch(tempFile, { persistent: false }, () => scheduleFileEmit());
            } catch (err) {
                cleanupNeovimSession(sessionId);
                throw err;
            }

            ptyProcess.onData((data: string) => {
                sendToWebContents(webContentsId, "neovim-data", { sessionId, data });
            });

            ptyProcess.onExit((evt) => {
                cleanupNeovimSession(sessionId);
                sendToWebContents(webContentsId, "neovim-exit", {
                    sessionId,
                    code: evt?.exitCode ?? null,
                    signal: evt?.signal ?? null,
                });
            });

            neovimSessions.set(sessionId, session);

            return { tempFile };
        }
    );

    electron.ipcMain.on("neovim-input", (event, payload: { sessionId: string; data: string }) => {
        const { sessionId, data } = payload ?? {};
        if (!sessionId || typeof data !== "string") {
            return;
        }
        const session = neovimSessions.get(sessionId);
        if (!session || session.webContentsId !== event.sender.id) {
            return;
        }
        try {
            session.pty.write(data);
        } catch (err) {
            console.error("Failed to write to Neovim session", sessionId, err);
        }
    });

    electron.ipcMain.on("neovim-resize", (event, payload: { sessionId: string; cols: number; rows: number }) => {
        const { sessionId, cols, rows } = payload ?? {};
        if (!sessionId) {
            return;
        }
        const session = neovimSessions.get(sessionId);
        if (!session || session.webContentsId !== event.sender.id) {
            return;
        }
        const termCols = Math.max(1, Math.floor(cols ?? 0));
        const termRows = Math.max(1, Math.floor(rows ?? 0));
        try {
            session.pty.resize(termCols, termRows);
        } catch (err) {
            console.warn("Failed to resize Neovim session", sessionId, err);
        }
    });

    electron.ipcMain.on("neovim-stop", (event, payload: { sessionId: string }) => {
        const { sessionId } = payload ?? {};
        if (!sessionId) {
            return;
        }
        const session = neovimSessions.get(sessionId);
        if (!session || session.webContentsId !== event.sender.id) {
            return;
        }
        cleanupNeovimSession(sessionId, true);
    });

    electron.ipcMain.on("open-external", (event, url) => {
        if (url && typeof url === "string") {
            fireAndForget(() =>
                callWithOriginalXdgCurrentDesktopAsync(() =>
                    electron.shell.openExternal(url).catch((err) => {
                        console.error(`Failed to open URL ${url}:`, err);
                    })
                )
            );
        } else {
            console.error("Invalid URL received in open-external event:", url);
        }
    });

    electron.ipcMain.on("webview-image-contextmenu", (event: electron.IpcMainEvent, payload: { src: string }) => {
        const menu = new electron.Menu();
        const win = getWaveWindowByWebContentsId(event.sender.hostWebContents.id);
        if (win == null) {
            return;
        }
        menu.append(
            new electron.MenuItem({
                label: "Save Image",
                click: () => {
                    const resultP = getUrlInSession(event.sender.session, payload.src);
                    resultP
                        .then((result) => {
                            saveImageFileWithNativeDialog(result.fileName, result.mimeType, result.stream);
                        })
                        .catch((e) => {
                            console.log("error getting image", e);
                        });
                },
            })
        );
        menu.popup();
    });

    electron.ipcMain.on("download", (event, payload) => {
        const baseName = encodeURIComponent(path.basename(payload.filePath));
        const streamingUrl =
            getWebServerEndpoint() + "/wave/stream-file/" + baseName + "?path=" + encodeURIComponent(payload.filePath);
        event.sender.downloadURL(streamingUrl);
    });

    electron.ipcMain.on("get-cursor-point", (event) => {
        const tabView = getWaveTabViewByWebContentsId(event.sender.id);
        if (tabView == null) {
            event.returnValue = null;
            return;
        }
        const screenPoint = electron.screen.getCursorScreenPoint();
        const windowRect = tabView.getBounds();
        const retVal: Electron.Point = {
            x: screenPoint.x - windowRect.x,
            y: screenPoint.y - windowRect.y,
        };
        event.returnValue = retVal;
    });

    electron.ipcMain.handle("capture-screenshot", async (event, rect) => {
        const tabView = getWaveTabViewByWebContentsId(event.sender.id);
        if (!tabView) {
            throw new Error("No tab view found for the given webContents id");
        }
        const image = await tabView.webContents.capturePage(rect);
        const base64String = image.toPNG().toString("base64");
        return `data:image/png;base64,${base64String}`;
    });

    electron.ipcMain.on("get-env", (event, varName) => {
        event.returnValue = process.env[varName] ?? null;
    });

    electron.ipcMain.on("get-about-modal-details", (event) => {
        event.returnValue = getWaveVersion() as AboutModalDetails;
    });

    electron.ipcMain.on("get-zoom-factor", (event) => {
        event.returnValue = event.sender.getZoomFactor();
    });

    const hasBeforeInputRegisteredMap = new Map<number, boolean>();

    electron.ipcMain.on("webview-focus", (event: Electron.IpcMainEvent, focusedId: number) => {
        webviewFocusId = focusedId;
        console.log("webview-focus", focusedId);
        if (focusedId == null) {
            return;
        }
        const parentWc = event.sender;
        const webviewWc = electron.webContents.fromId(focusedId);
        if (webviewWc == null) {
            webviewFocusId = null;
            return;
        }
        if (!hasBeforeInputRegisteredMap.get(focusedId)) {
            hasBeforeInputRegisteredMap.set(focusedId, true);
            webviewWc.on("before-input-event", (e, input) => {
                let waveEvent = keyutil.adaptFromElectronKeyEvent(input);
                handleCtrlShiftState(parentWc, waveEvent);
                if (webviewFocusId != focusedId) {
                    return;
                }
                if (input.type != "keyDown") {
                    return;
                }
                for (let keyDesc of webviewKeys) {
                    if (keyutil.checkKeyPressed(waveEvent, keyDesc)) {
                        e.preventDefault();
                        parentWc.send("reinject-key", waveEvent);
                        console.log("webview reinject-key", keyDesc);
                        return;
                    }
                }
            });
            webviewWc.on("destroyed", () => {
                hasBeforeInputRegisteredMap.delete(focusedId);
            });
        }
    });

    electron.ipcMain.on("register-global-webview-keys", (event, keys: string[]) => {
        webviewKeys = keys ?? [];
    });

    electron.ipcMain.on("set-keyboard-chord-mode", (event) => {
        event.returnValue = null;
        const tabView = getWaveTabViewByWebContentsId(event.sender.id);
        tabView?.setKeyboardChordMode(true);
    });

    if (unamePlatform !== "darwin") {
        const fac = new FastAverageColor();

        electron.ipcMain.on("update-window-controls-overlay", async (event, rect: Dimensions) => {
            const fullConfig = await RpcApi.GetFullConfigCommand(ElectronWshClient);
            if (fullConfig.settings["window:nativetitlebar"]) return;

            const zoomFactor = event.sender.getZoomFactor();
            const electronRect: Electron.Rectangle = {
                x: rect.left * zoomFactor,
                y: rect.top * zoomFactor,
                height: rect.height * zoomFactor,
                width: rect.width * zoomFactor,
            };
            const overlay = await event.sender.capturePage(electronRect);
            const overlayBuffer = overlay.toPNG();
            const png = PNG.sync.read(overlayBuffer);
            const color = fac.prepareResult(fac.getColorFromArray4(png.data));
            const ww = getWaveWindowByWebContentsId(event.sender.id);
            ww.setTitleBarOverlay({
                color: unamePlatform === "linux" ? color.rgba : "#00000000",
                symbolColor: color.isDark ? "white" : "black",
            });
        });
    }

    electron.ipcMain.on("quicklook", (event, filePath: string) => {
        if (unamePlatform == "darwin") {
            child_process.execFile("/usr/bin/qlmanage", ["-p", filePath], (error, stdout, stderr) => {
                if (error) {
                    console.error(`Error opening Quick Look: ${error}`);
                    return;
                }
            });
        }
    });

    electron.ipcMain.handle("clear-webview-storage", async (event, webContentsId: number) => {
        try {
            const wc = electron.webContents.fromId(webContentsId);
            if (wc && wc.session) {
                await wc.session.clearStorageData();
                console.log("Cleared cookies and storage for webContentsId:", webContentsId);
            }
        } catch (e) {
            console.error("Failed to clear cookies and storage:", e);
            throw e;
        }
    });

    electron.ipcMain.on("open-native-path", (event, filePath: string) => {
        console.log("open-native-path", filePath);
        filePath = filePath.replace("~", electronApp.getPath("home"));
        fireAndForget(() =>
            callWithOriginalXdgCurrentDesktopAsync(() =>
                electron.shell.openPath(filePath).then((excuse) => {
                    if (excuse) console.error(`Failed to open ${filePath} in native application: ${excuse}`);
                })
            )
        );
    });

    electron.ipcMain.on("open-with-cursor", (_event, filePath: string) => {
        openFileWithCursor(filePath);
    });

    electron.ipcMain.on("set-window-init-status", (event, status: "ready" | "wave-ready") => {
        const tabView = getWaveTabViewByWebContentsId(event.sender.id);
        if (tabView != null && tabView.initResolve != null) {
            if (status === "ready") {
                tabView.initResolve();
                if (tabView.savedInitOpts) {
                    console.log("savedInitOpts calling wave-init", tabView.waveTabId);
                    tabView.webContents.send("wave-init", tabView.savedInitOpts);
                }
            } else if (status === "wave-ready") {
                tabView.waveReadyResolve();
            }
            return;
        }

        const builderWindow = getBuilderWindowByWebContentsId(event.sender.id);
        if (builderWindow != null) {
            if (status === "ready") {
                if (builderWindow.savedInitOpts) {
                    console.log("savedInitOpts calling builder-init", builderWindow.savedInitOpts.builderId);
                    builderWindow.webContents.send("builder-init", builderWindow.savedInitOpts);
                }
            }
            return;
        }

        console.log("set-window-init-status: no window found for webContentsId", event.sender.id);
    });

    electron.ipcMain.on("fe-log", (event, logStr: string) => {
        console.log("fe-log", logStr);
    });

    electron.ipcMain.on("increment-term-commands", () => {
        incrementTermCommandsRun();
    });

    electron.ipcMain.on("native-paste", (event) => {
        event.sender.paste();
    });

    electron.ipcMain.on("open-builder", (event, appId?: string) => {
        fireAndForget(() => createBuilderWindow(appId || ""));
    });

    electron.ipcMain.on("open-new-window", () => fireAndForget(createNewWaveWindow));

    electron.ipcMain.on("close-builder-window", async (event) => {
        const bw = getBuilderWindowByWebContentsId(event.sender.id);
        if (bw == null) {
            return;
        }
        const builderId = bw.builderId;
        if (builderId) {
            try {
                await RpcApi.SetRTInfoCommand(ElectronWshClient, {
                    oref: `builder:${builderId}`,
                    data: {} as ObjRTInfo,
                    delete: true,
                });
            } catch (e) {
                console.error("Error deleting builder rtinfo:", e);
            }
        }
        bw.destroy();
    });
}
