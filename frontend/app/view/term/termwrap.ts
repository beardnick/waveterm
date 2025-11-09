// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getFileSubject } from "@/app/store/wps";
import { sendWSCommand } from "@/app/store/ws";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import {
    WOS,
    atoms,
    createBlock,
    fetchWaveFile,
    getApi,
    getSettingsKeyAtom,
    globalStore,
    openLink,
} from "@/store/global";
import * as services from "@/store/services";
import { PLATFORM, PlatformMacOS } from "@/util/platformutil";
import { base64ToArray, base64ToString, fireAndForget } from "@/util/util";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import * as TermTypes from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import debug from "debug";
import * as jotai from "jotai";
import { debounce } from "throttle-debounce";
import { FitAddon } from "./fitaddon";
import { createTempFileFromBlob, extractAllClipboardData } from "./termutil";

const dlog = debug("wave:termwrap");

const TermFileName = "term";
const TermCacheFileName = "cache:term:full";
const MinDataProcessedForCache = 100 * 1024;
export const SupportsImageInput = true;

const MarkdownExtensions = new Set(["md", "mdx", "markdown"]);
const ImageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tiff", "tif", "ico", "heic"]);
const CodeExtensions = new Set([
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "json",
    "css",
    "scss",
    "less",
    "html",
    "svelte",
    "astro",
    "vue",
    "py",
    "rb",
    "rs",
    "go",
    "java",
    "kt",
    "swift",
    "scala",
    "c",
    "cc",
    "cpp",
    "cxx",
    "h",
    "hpp",
    "cs",
    "php",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "psm1",
    "sql",
    "toml",
    "yaml",
    "yml",
    "ini",
    "cfg",
    "tex",
    "rsx",
]);

type FileLinkCandidate = {
    displayText: string;
    canonicalName: string;
    columnStart: number;
    columnEnd: number;
    isDirectory: boolean;
};

const termWrapInstances = new Map<string, TermWrap>();

function extractPathFromLine(text: string): string | null {
    if (!text) {
        return null;
    }
    const matches = text.match(/((?:~\/|\/)[^\s]+)/g);
    if (matches && matches.length > 0) {
        return matches[matches.length - 1];
    }
    return null;
}

function sanitizeDisplayedName(display: string): string {
    if (!display) {
        return display;
    }
    const trailingIndicators = new Set(["/", "*", "@", "=", "|"]);
    let sanitized = display;
    while (sanitized.length > 0 && trailingIndicators.has(sanitized[sanitized.length - 1])) {
        sanitized = sanitized.slice(0, -1);
    }
    return sanitized.length > 0 ? sanitized : display;
}

function looksLikeLsLongFormatLine(line: string): boolean {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("total ")) {
        return false;
    }
    const lsPattern = /^[\-ldcbps][rwxstST\-]{9}[@+\-]?\s+/;
    return lsPattern.test(trimmed);
}

function extractFileCandidateFromLongListing(rawLine: string): FileLinkCandidate | null {
    if (rawLine == null || rawLine.length === 0) {
        return null;
    }
    const lineWithoutTrailingWhitespace = rawLine.replace(/\s+$/, "");
    if (!looksLikeLsLongFormatLine(lineWithoutTrailingWhitespace)) {
        return null;
    }
    let inspectLine = lineWithoutTrailingWhitespace;
    const arrowIdx = inspectLine.indexOf(" -> ");
    if (arrowIdx !== -1) {
        inspectLine = inspectLine.slice(0, arrowIdx);
    }
    let idx = 0;
    const len = inspectLine.length;
    let fieldsConsumed = 0;
    while (idx < len && fieldsConsumed < 8) {
        while (idx < len && inspectLine[idx] === " ") {
            idx++;
        }
        while (idx < len && inspectLine[idx] !== " ") {
            idx++;
        }
        fieldsConsumed++;
        while (idx < len && inspectLine[idx] === " ") {
            idx++;
        }
    }
    if (idx >= len) {
        return null;
    }
    const displayText = inspectLine.slice(idx);
    if (displayText.length === 0) {
        return null;
    }
    const canonicalName = sanitizeDisplayedName(displayText);
    if (!canonicalName) {
        return null;
    }
    const trimmed = lineWithoutTrailingWhitespace.trimStart();
    const isDirectory = trimmed.startsWith("d") || canonicalName.endsWith("/");
    return {
        displayText,
        canonicalName,
        columnStart: idx + 1,
        columnEnd: idx + 1 + displayText.length,
        isDirectory,
    };
}

function isWindowsStylePath(pathStr: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(pathStr) || pathStr.startsWith("\\\\");
}

function extractFileCandidatesFromLine(rawLine: string): FileLinkCandidate[] {
    const candidates: FileLinkCandidate[] = [];
    const longListingCandidate = extractFileCandidateFromLongListing(rawLine);
    if (longListingCandidate) {
        candidates.push(longListingCandidate);
        return candidates;
    }
    if (rawLine == null || rawLine.trim().length === 0) {
        return candidates;
    }
    const seen = new Set<string>();
    const columnRegex = /(\S[\S ]*?)(?=\s{2,}|\s*$)/g;
    let match: RegExpExecArray;
    while ((match = columnRegex.exec(rawLine)) != null) {
        const segment = match[1];
        if (!segment) {
            continue;
        }
        const leadingTrim = segment.length - segment.trimStart().length;
        const trailingTrim = segment.length - segment.trimEnd().length;
        const trimmedSegment = segment.trim();
        if (trimmedSegment.length === 0) {
            continue;
        }
        const startIdx = match.index + leadingTrim;
        const endIdx = match.index + segment.length - trailingTrim;
        const sanitized = sanitizeDisplayedName(trimmedSegment);
        if (!sanitized) {
            continue;
        }
        const dedupeKey = `${startIdx}:${sanitized}`;
        if (seen.has(dedupeKey)) {
            continue;
        }
        seen.add(dedupeKey);
        const isDirectory = trimmedSegment.endsWith("/") || (!sanitized.includes(".") && !sanitized.includes(":"));
        candidates.push({
            displayText: trimmedSegment,
            canonicalName: sanitized,
            columnStart: startIdx + 1,
            columnEnd: endIdx + 1,
            isDirectory,
        });
    }
    return candidates;
}

function joinPosixPath(base: string, relative: string): string {
    const baseIsAbsolute = base.startsWith("/");
    const baseSegments = base.split("/").filter((segment) => segment.length > 0);
    const relativeSegments = relative.split("/").filter((segment) => segment.length > 0 || segment === "..");
    const stack = baseSegments.slice();

    for (const segment of relativeSegments) {
        if (!segment || segment === ".") {
            continue;
        }
        if (segment === "..") {
            if (stack.length > 0) {
                stack.pop();
            }
            continue;
        }
        stack.push(segment);
    }

    const prefix = baseIsAbsolute ? "/" : "";
    return prefix + stack.join("/");
}

function resolvePathRelativeToCwd(rawName: string, cwd: string | null, homeDir: string | null): string {
    if (!rawName) {
        return null;
    }
    const trimmed = rawName.trim();
    if (trimmed.length === 0) {
        return null;
    }
    if (trimmed === "~") {
        if (homeDir) {
            return homeDir;
        }
        return trimmed;
    }
    if (trimmed.startsWith("~/")) {
        if (homeDir) {
            const suffix = trimmed.slice(2);
            return homeDir.endsWith("/") ? `${homeDir}${suffix}` : `${homeDir}/${suffix}`;
        }
        return trimmed;
    }
    if (trimmed.startsWith("/") || isWindowsStylePath(trimmed)) {
        return trimmed;
    }
    if (!cwd || cwd.length === 0) {
        return trimmed;
    }
    let base = cwd;
    if (base === "~") {
        base = homeDir ?? base;
    }
    if (base?.startsWith("~/")) {
        const suffix = base.slice(2);
        if (homeDir?.length > 0) {
            base = homeDir.endsWith("/") ? `${homeDir}${suffix}` : `${homeDir}/${suffix}`;
        } else {
            return joinPosixPath(base, trimmed);
        }
    }
    if (isWindowsStylePath(base)) {
        const normalizedBase = base.replace(/\\/g, "/");
        const normalizedRelative = trimmed.replace(/\\/g, "/");
        const joined = joinPosixPath(normalizedBase, normalizedRelative);
        return joined.replace(/\//g, "\\");
    }
    return joinPosixPath(base, trimmed);
}

type FileCategory = "directory" | "markdown" | "image" | "code" | "other";

function inferFileCategory(name: string, isDirectory: boolean): FileCategory {
    if (isDirectory) {
        return "directory";
    }
    if (!name) {
        return "other";
    }
    const lower = name.toLowerCase();
    const dotIdx = lower.lastIndexOf(".");
    if (dotIdx <= 0) {
        return "other";
    }
    const ext = lower.slice(dotIdx + 1);
    if (MarkdownExtensions.has(ext)) {
        return "markdown";
    }
    if (ImageExtensions.has(ext)) {
        return "image";
    }
    if (CodeExtensions.has(ext)) {
        return "code";
    }
    return "other";
}

// detect webgl support
function detectWebGLSupport(): boolean {
    try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("webgl");
        return !!ctx;
    } catch (e) {
        return false;
    }
}

const WebGLSupported = detectWebGLSupport();
let loggedWebGL = false;

type TermWrapOptions = {
    keydownHandler?: (e: KeyboardEvent) => boolean;
    useWebGl?: boolean;
    sendDataHandler?: (data: string) => void;
};

function handleOscWaveCommand(data: string, blockId: string, loaded: boolean): boolean {
    if (!loaded) {
        return true;
    }
    if (!data || data.length === 0) {
        console.log("Invalid Wave OSC command received (empty)");
        return true;
    }

    // Expected formats:
    // "setmeta;{JSONDATA}"
    // "setmeta;[wave-id];{JSONDATA}"
    const parts = data.split(";");
    if (parts[0] !== "setmeta") {
        console.log("Invalid Wave OSC command received (bad command)", data);
        return true;
    }
    let jsonPayload: string;
    let waveId: string | undefined;
    if (parts.length === 2) {
        jsonPayload = parts[1];
    } else if (parts.length >= 3) {
        waveId = parts[1];
        jsonPayload = parts.slice(2).join(";");
    } else {
        console.log("Invalid Wave OSC command received (1 part)", data);
        return true;
    }

    let meta: any;
    try {
        meta = JSON.parse(jsonPayload);
    } catch (e) {
        console.error("Invalid JSON in Wave OSC command:", e);
        return true;
    }

    if (waveId) {
        // Resolve the wave id to an ORef using our ResolveIdsCommand.
        fireAndForget(() => {
            return RpcApi.ResolveIdsCommand(TabRpcClient, { blockid: blockId, ids: [waveId] })
                .then((response: { resolvedids: { [key: string]: any } }) => {
                    const oref = response.resolvedids[waveId];
                    if (!oref) {
                        console.error("Failed to resolve wave id:", waveId);
                        return;
                    }
                    services.ObjectService.UpdateObjectMeta(oref, meta);
                })
                .catch((err: any) => {
                    console.error("Error resolving wave id", waveId, err);
                });
        });
    } else {
        // No wave id provided; update using the current block id.
        fireAndForget(() => {
            return services.ObjectService.UpdateObjectMeta(WOS.makeORef("block", blockId), meta);
        });
    }
    return true;
}

// for xterm handlers, we return true always because we "own" OSC 7.
// even if it is invalid we dont want to propagate to other handlers
function handleOsc7Command(data: string, blockId: string, loaded: boolean): boolean {
    if (!loaded) {
        return true;
    }
    if (data == null || data.length == 0) {
        console.log("Invalid OSC 7 command received (empty)");
        return true;
    }
    if (data.length > 1024) {
        console.log("Invalid OSC 7, data length too long", data.length);
        return true;
    }

    let pathPart: string;
    try {
        const url = new URL(data);
        if (url.protocol !== "file:") {
            console.log("Invalid OSC 7 command received (non-file protocol)", data);
            return true;
        }
        pathPart = decodeURIComponent(url.pathname);

        // Normalize double slashes at the beginning to single slash
        if (pathPart.startsWith("//")) {
            pathPart = pathPart.substring(1);
        }

        // Handle Windows paths (e.g., /C:/... or /D:\...)
        if (/^\/[a-zA-Z]:[\\/]/.test(pathPart)) {
            // Strip leading slash and normalize to forward slashes
            pathPart = pathPart.substring(1).replace(/\\/g, "/");
        }

        // Handle UNC paths (e.g., /\\server\share)
        if (pathPart.startsWith("/\\\\")) {
            // Strip leading slash but keep backslashes for UNC
            pathPart = pathPart.substring(1);
        }
    } catch (e) {
        console.log("Invalid OSC 7 command received (parse error)", data, e);
        return true;
    }

    const termWrapInstance = termWrapInstances.get(blockId);
    if (termWrapInstance) {
        termWrapInstance.lastKnownCwd = pathPart;
    }

    setTimeout(() => {
        fireAndForget(async () => {
            await services.ObjectService.UpdateObjectMeta(WOS.makeORef("block", blockId), {
                "cmd:cwd": pathPart,
            });

            const rtInfo = { "shell:hascurcwd": true };
            const rtInfoData: CommandSetRTInfoData = {
                oref: WOS.makeORef("block", blockId),
                data: rtInfo,
            };
            await RpcApi.SetRTInfoCommand(TabRpcClient, rtInfoData).catch((e) =>
                console.log("error setting RT info", e)
            );
        });
    }, 0);
    return true;
}

// some POC concept code for adding a decoration to a marker
function addTestMarkerDecoration(terminal: Terminal, marker: TermTypes.IMarker, termWrap: TermWrap): void {
    const decoration = terminal.registerDecoration({
        marker: marker,
        layer: "top",
    });
    if (!decoration) {
        return;
    }
    decoration.onRender((el) => {
        el.classList.add("wave-decoration");
        el.classList.add("bg-ansi-white");
        el.dataset.markerline = String(marker.line);
        if (!el.querySelector(".wave-deco-line")) {
            const line = document.createElement("div");
            line.classList.add("wave-deco-line", "bg-accent/20");
            line.style.position = "absolute";
            line.style.top = "0";
            line.style.left = "0";
            line.style.width = "500px";
            line.style.height = "1px";
            el.appendChild(line);
        }
    });
}

// OSC 16162 - Shell Integration Commands
// See aiprompts/wave-osc-16162.md for full documentation
type ShellIntegrationStatus = "ready" | "running-command";

type Osc16162Command =
    | { command: "A"; data: {} }
    | { command: "C"; data: { cmd64?: string } }
    | { command: "M"; data: { shell?: string; shellversion?: string; uname?: string; integration?: boolean } }
    | { command: "D"; data: { exitcode?: number } }
    | { command: "I"; data: { inputempty?: boolean } }
    | { command: "R"; data: {} };

function handleOsc16162Command(data: string, blockId: string, loaded: boolean, termWrap: TermWrap): boolean {
    const terminal = termWrap.terminal;
    if (!loaded) {
        return true;
    }
    if (!data || data.length === 0) {
        return true;
    }

    const parts = data.split(";");
    const commandStr = parts[0];
    const jsonDataStr = parts.length > 1 ? parts.slice(1).join(";") : null;
    let parsedData: Record<string, any> = {};
    if (jsonDataStr) {
        try {
            parsedData = JSON.parse(jsonDataStr);
        } catch (e) {
            console.error("Error parsing OSC 16162 JSON data:", e);
        }
    }

    const cmd: Osc16162Command = { command: commandStr, data: parsedData } as Osc16162Command;
    const rtInfo: ObjRTInfo = {};
    switch (cmd.command) {
        case "A":
            rtInfo["shell:state"] = "ready";
            globalStore.set(termWrap.shellIntegrationStatusAtom, "ready");
            const marker = terminal.registerMarker(0);
            if (marker) {
                termWrap.promptMarkers.push(marker);
                // addTestMarkerDecoration(terminal, marker, termWrap);
                marker.onDispose(() => {
                    const idx = termWrap.promptMarkers.indexOf(marker);
                    if (idx !== -1) {
                        termWrap.promptMarkers.splice(idx, 1);
                    }
                });
            }
            break;
        case "C":
            rtInfo["shell:state"] = "running-command";
            globalStore.set(termWrap.shellIntegrationStatusAtom, "running-command");
            getApi().incrementTermCommands();
            if (cmd.data.cmd64) {
                const decodedLen = Math.ceil(cmd.data.cmd64.length * 0.75);
                if (decodedLen > 8192) {
                    rtInfo["shell:lastcmd"] = `# command too large (${decodedLen} bytes)`;
                    globalStore.set(termWrap.lastCommandAtom, rtInfo["shell:lastcmd"]);
                } else {
                    try {
                        const decodedCmd = base64ToString(cmd.data.cmd64);
                        rtInfo["shell:lastcmd"] = decodedCmd;
                        globalStore.set(termWrap.lastCommandAtom, decodedCmd);
                    } catch (e) {
                        console.error("Error decoding cmd64:", e);
                        rtInfo["shell:lastcmd"] = null;
                        globalStore.set(termWrap.lastCommandAtom, null);
                    }
                }
            } else {
                rtInfo["shell:lastcmd"] = null;
                globalStore.set(termWrap.lastCommandAtom, null);
            }
            // also clear lastcmdexitcode (since we've now started a new command)
            rtInfo["shell:lastcmdexitcode"] = null;
            break;
        case "M":
            if (cmd.data.shell) {
                rtInfo["shell:type"] = cmd.data.shell;
            }
            if (cmd.data.shellversion) {
                rtInfo["shell:version"] = cmd.data.shellversion;
            }
            if (cmd.data.uname) {
                rtInfo["shell:uname"] = cmd.data.uname;
            }
            if (cmd.data.integration != null) {
                rtInfo["shell:integration"] = cmd.data.integration;
            }
            break;
        case "D":
            if (cmd.data.exitcode != null) {
                rtInfo["shell:lastcmdexitcode"] = cmd.data.exitcode;
            } else {
                rtInfo["shell:lastcmdexitcode"] = null;
            }
            break;
        case "I":
            if (cmd.data.inputempty != null) {
                rtInfo["shell:inputempty"] = cmd.data.inputempty;
            }
            break;
        case "R":
            globalStore.set(termWrap.shellIntegrationStatusAtom, null);
            if (terminal.buffer.active.type === "alternate") {
                terminal.write("\x1b[?1049l");
            }
            break;
    }

    if (Object.keys(rtInfo).length > 0) {
        setTimeout(() => {
            fireAndForget(async () => {
                const rtInfoData: CommandSetRTInfoData = {
                    oref: WOS.makeORef("block", blockId),
                    data: rtInfo,
                };
                await RpcApi.SetRTInfoCommand(TabRpcClient, rtInfoData).catch((e) =>
                    console.log("error setting RT info (OSC 16162)", e)
                );
            });
        }, 0);
    }

    return true;
}

export class TermWrap {
    blockId: string;
    ptyOffset: number;
    dataBytesProcessed: number;
    terminal: Terminal;
    connectElem: HTMLDivElement;
    fitAddon: FitAddon;
    searchAddon: SearchAddon;
    serializeAddon: SerializeAddon;
    mainFileSubject: SubjectWithRef<WSFileEventData>;
    loaded: boolean;
    heldData: Uint8Array[];
    handleResize_debounced: () => void;
    hasResized: boolean;
    multiInputCallback: (data: string) => void;
    /**
     * Allows callers to intercept user input before it is dispatched to the controller.
     * When the interceptor returns true, the input will be considered handled and not forwarded.
     */
    inputInterceptionCallback?: (data: string) => boolean;
    /**
     * Callback that fires right before data is sent to the controller (after interception).
     * Useful for tracking user input state.
     */
    beforeSendInputCallback?: (data: string) => void;
    sendDataHandler: (data: string) => void;
    onSearchResultsDidChange?: (result: { resultIndex: number; resultCount: number }) => void;
    private toDispose: TermTypes.IDisposable[] = [];
    pasteActive: boolean = false;
    lastUpdated: number;
    promptMarkers: TermTypes.IMarker[] = [];
    shellIntegrationStatusAtom: jotai.PrimitiveAtom<"ready" | "running-command" | null>;
    lastCommandAtom: jotai.PrimitiveAtom<string | null>;

    // IME composition state tracking
    // Prevents duplicate input when switching input methods during composition (e.g., using Capslock)
    // xterm.js sends data during compositionupdate AND after compositionend, causing duplicates
    isComposing: boolean = false;
    composingData: string = "";
    lastCompositionEnd: number = 0;
    lastComposedText: string = "";
    firstDataAfterCompositionSent: boolean = false;

    // Paste deduplication
    // xterm.js paste() method triggers onData event, which can cause duplicate sends
    lastPasteData: string = "";
    lastPasteTime: number = 0;
    lastKnownCwd: string | null = null;

    constructor(
        blockId: string,
        connectElem: HTMLDivElement,
        options: TermTypes.ITerminalOptions & TermTypes.ITerminalInitOnlyOptions,
        waveOptions: TermWrapOptions
    ) {
        this.loaded = false;
        this.blockId = blockId;
        this.sendDataHandler = waveOptions.sendDataHandler;
        this.ptyOffset = 0;
        this.dataBytesProcessed = 0;
        this.hasResized = false;
        this.lastUpdated = Date.now();
        this.promptMarkers = [];
        this.shellIntegrationStatusAtom = jotai.atom(null) as jotai.PrimitiveAtom<"ready" | "running-command" | null>;
        this.lastCommandAtom = jotai.atom(null) as jotai.PrimitiveAtom<string | null>;
        termWrapInstances.set(blockId, this);
        this.terminal = new Terminal(options);
        this.fitAddon = new FitAddon();
        this.fitAddon.noScrollbar = PLATFORM === PlatformMacOS;
        this.serializeAddon = new SerializeAddon();
        this.searchAddon = new SearchAddon();
        this.terminal.loadAddon(this.searchAddon);
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(this.serializeAddon);
        this.terminal.loadAddon(
            new WebLinksAddon((e, uri) => {
                e.preventDefault();
                switch (PLATFORM) {
                    case PlatformMacOS:
                        if (e.metaKey) {
                            fireAndForget(() => openLink(uri));
                        }
                        break;
                    default:
                        if (e.ctrlKey) {
                            fireAndForget(() => openLink(uri));
                        }
                        break;
                }
            })
        );
        this.toDispose.push(this.registerFileLinkProvider());
        if (WebGLSupported && waveOptions.useWebGl) {
            const webglAddon = new WebglAddon();
            this.toDispose.push(
                webglAddon.onContextLoss(() => {
                    webglAddon.dispose();
                })
            );
            this.terminal.loadAddon(webglAddon);
            if (!loggedWebGL) {
                console.log("loaded webgl!");
                loggedWebGL = true;
            }
        }
        // Register OSC 9283 handler
        this.terminal.parser.registerOscHandler(9283, (data: string) => {
            return handleOscWaveCommand(data, this.blockId, this.loaded);
        });
        this.terminal.parser.registerOscHandler(7, (data: string) => {
            return handleOsc7Command(data, this.blockId, this.loaded);
        });
        this.terminal.parser.registerOscHandler(16162, (data: string) => {
            return handleOsc16162Command(data, this.blockId, this.loaded, this);
        });
        this.terminal.attachCustomKeyEventHandler(waveOptions.keydownHandler);
        this.connectElem = connectElem;
        this.mainFileSubject = null;
        this.heldData = [];
        this.handleResize_debounced = debounce(50, this.handleResize.bind(this));
        this.terminal.open(this.connectElem);
        this.handleResize();
        const pasteHandler = this.pasteHandler.bind(this);
        this.connectElem.addEventListener("paste", pasteHandler, true);
        this.toDispose.push({
            dispose: () => {
                this.connectElem.removeEventListener("paste", pasteHandler, true);
            },
        });
    }

    private registerFileLinkProvider(): TermTypes.IDisposable {
        const provider: TermTypes.ILinkProvider = {
            provideLinks: (bufferLineNumber, callback) => {
                const buffer = this.terminal?.buffer?.active;
                if (!buffer) {
                    callback(undefined);
                    return;
                }
                const line = buffer.getLine(bufferLineNumber - 1);
                if (!line) {
                    callback(undefined);
                    return;
                }
                const lineText = line.translateToString(false);
                const lineCandidates = extractFileCandidatesFromLine(lineText);
                if (lineCandidates.length === 0) {
                    callback(undefined);
                    return;
                }
                const links = lineCandidates.map((candidate) => {
                    const link: TermTypes.ILink = {
                        text: candidate.displayText,
                        range: {
                            start: { x: candidate.columnStart, y: bufferLineNumber },
                            end: { x: candidate.columnEnd, y: bufferLineNumber },
                        },
                        decorations: {
                            pointerCursor: true,
                            underline: true,
                        },
                        activate: (event) => {
                            this.handleFileLinkActivate(event, candidate);
                            this.terminal.clearSelection();
                            setTimeout(() => this.terminal.focus(), 0);
                        },
                    };
                    return link;
                });
                callback(links);
            },
        };
        return this.terminal.registerLinkProvider(provider);
    }

    private handleFileLinkActivate(event: MouseEvent, candidate: FileLinkCandidate): void {
        const modifierPressed = PLATFORM === PlatformMacOS ? event.metaKey : event.ctrlKey;
        if (!modifierPressed) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();

        const blockAtom = WOS.getWaveObjectAtom(WOS.makeORef("block", this.blockId));
        const blockData = globalStore.get(blockAtom);
        const connection = blockData?.meta?.connection ?? null;
        const metaCwd = blockData?.meta?.["cmd:cwd"] ?? null;
        const isLocalConnection = connection == null || connection === "" || connection === "local";
        const homeDir = isLocalConnection ? getApi().getHomeDir() : null;
        let cwd = metaCwd ?? this.lastKnownCwd;
        if (!cwd) {
            const promptPath = this.getPromptDirectory();
            if (promptPath) {
                cwd = promptPath;
                this.lastKnownCwd = promptPath;
            }
        }
        if (!cwd) {
            cwd = isLocalConnection ? "~" : null;
        }
        const resolvedPath = resolvePathRelativeToCwd(candidate.canonicalName, cwd, homeDir);
        if (!resolvedPath) {
            console.warn("Unable to resolve path for terminal file link", candidate.canonicalName);
            return;
        }

        const category = inferFileCategory(candidate.canonicalName, candidate.isDirectory);

        if (category === "code" && isLocalConnection) {
            try {
                getApi().openWithCursor(resolvedPath);
            } catch (err) {
                console.error("Failed to open Cursor for file", resolvedPath, err);
            }
            return;
        }

        const blockDef: BlockDef = {
            meta: {
                view: "preview",
                file: resolvedPath,
            },
        };
        if (connection) {
            blockDef.meta.connection = connection;
        }
        fireAndForget(async () => {
            await createBlock(blockDef);
        });
    }

    resetCompositionState() {
        this.isComposing = false;
        this.composingData = "";
    }

    private handleCompositionStart = (e: CompositionEvent) => {
        dlog("compositionstart", e.data);
        this.isComposing = true;
        this.composingData = "";
    };

    private handleCompositionUpdate = (e: CompositionEvent) => {
        dlog("compositionupdate", e.data);
        this.composingData = e.data || "";
    };

    private handleCompositionEnd = (e: CompositionEvent) => {
        dlog("compositionend", e.data);
        this.isComposing = false;
        this.lastComposedText = e.data || "";
        this.lastCompositionEnd = Date.now();
        this.firstDataAfterCompositionSent = false;
    };

    async initTerminal() {
        const copyOnSelectAtom = getSettingsKeyAtom("term:copyonselect");
        this.toDispose.push(this.terminal.onData(this.handleTermData.bind(this)));
        this.toDispose.push(this.terminal.onKey(this.onKeyHandler.bind(this)));
        this.toDispose.push(
            this.terminal.onSelectionChange(
                debounce(50, () => {
                    if (!globalStore.get(copyOnSelectAtom)) {
                        return;
                    }
                    const selectedText = this.terminal.getSelection();
                    if (selectedText.length > 0) {
                        navigator.clipboard.writeText(selectedText);
                    }
                })
            )
        );
        if (this.onSearchResultsDidChange != null) {
            this.toDispose.push(this.searchAddon.onDidChangeResults(this.onSearchResultsDidChange.bind(this)));
        }

        // Register IME composition event listeners on the xterm.js textarea
        const textareaElem = this.connectElem.querySelector("textarea");
        if (textareaElem) {
            textareaElem.addEventListener("compositionstart", this.handleCompositionStart);
            textareaElem.addEventListener("compositionupdate", this.handleCompositionUpdate);
            textareaElem.addEventListener("compositionend", this.handleCompositionEnd);

            // Handle blur during composition - reset state to avoid stale data
            const blurHandler = () => {
                if (this.isComposing) {
                    dlog("Terminal lost focus during composition, resetting IME state");
                    this.resetCompositionState();
                }
            };
            textareaElem.addEventListener("blur", blurHandler);

            this.toDispose.push({
                dispose: () => {
                    textareaElem.removeEventListener("compositionstart", this.handleCompositionStart);
                    textareaElem.removeEventListener("compositionupdate", this.handleCompositionUpdate);
                    textareaElem.removeEventListener("compositionend", this.handleCompositionEnd);
                    textareaElem.removeEventListener("blur", blurHandler);
                },
            });
        }

        this.mainFileSubject = getFileSubject(this.blockId, TermFileName);
        this.mainFileSubject.subscribe(this.handleNewFileSubjectData.bind(this));

        try {
            const rtInfo = await RpcApi.GetRTInfoCommand(TabRpcClient, {
                oref: WOS.makeORef("block", this.blockId),
            });

            if (rtInfo["shell:integration"]) {
                const shellState = rtInfo["shell:state"] as ShellIntegrationStatus;
                globalStore.set(this.shellIntegrationStatusAtom, shellState || null);
            } else {
                globalStore.set(this.shellIntegrationStatusAtom, null);
            }

            const lastCmd = rtInfo["shell:lastcmd"];
            globalStore.set(this.lastCommandAtom, lastCmd || null);
        } catch (e) {
            console.log("Error loading runtime info:", e);
        }

        try {
            await this.loadInitialTerminalData();
        } finally {
            this.loaded = true;
        }
        this.runProcessIdleTimeout();
    }

    dispose() {
        this.promptMarkers.forEach((marker) => {
            try {
                marker.dispose();
            } catch (_) {}
        });
        this.promptMarkers = [];
        this.terminal.dispose();
        this.toDispose.forEach((d) => {
            try {
                d.dispose();
            } catch (_) {}
        });
        this.mainFileSubject.release();
        termWrapInstances.delete(this.blockId);
    }

    private getPromptDirectory(): string | null {
        const buffer = this.terminal?.buffer?.active;
        if (!buffer) {
            return null;
        }
        const cursorLine = buffer.baseY + buffer.cursorY;
        for (let offset = 0; offset < 3; offset++) {
            const line = buffer.getLine(cursorLine - offset);
            if (!line) {
                continue;
            }
            const text = line.translateToString(true);
            const extracted = extractPathFromLine(text);
            if (extracted) {
                return extracted;
            }
        }
        return null;
    }

    handleTermData(data: string) {
        if (!this.loaded) {
            return;
        }

        // IME Composition Handling
        // Block all data during composition - only send the final text after compositionend
        // This prevents xterm.js from sending intermediate composition data (e.g., during compositionupdate)
        if (this.isComposing) {
            dlog("Blocked data during composition:", data);
            return;
        }

        if (this.inputInterceptionCallback) {
            try {
                const handled = this.inputInterceptionCallback(data);
                if (handled) {
                    return;
                }
            } catch (err) {
                console.error("Error in input interception callback:", err);
            }
        }

        if (this.pasteActive) {
            if (this.multiInputCallback) {
                this.multiInputCallback(data);
            }
        }

        this.beforeSendInputCallback?.(data);

        // IME Deduplication (for Capslock input method switching)
        // When switching input methods with Capslock during composition, some systems send the
        // composed text twice. We allow the first send and block subsequent duplicates.
        const IMEDedupWindowMs = 50;
        const now = Date.now();
        const timeSinceCompositionEnd = now - this.lastCompositionEnd;
        if (timeSinceCompositionEnd < IMEDedupWindowMs && data === this.lastComposedText && this.lastComposedText) {
            if (!this.firstDataAfterCompositionSent) {
                // First send after composition - allow it but mark as sent
                this.firstDataAfterCompositionSent = true;
                dlog("First data after composition, allowing:", data);
            } else {
                // Second send of the same data - this is a duplicate from Capslock switching, block it
                dlog("Blocked duplicate IME data:", data);
                this.lastComposedText = ""; // Clear to allow same text to be typed again later
                this.firstDataAfterCompositionSent = false;
                return;
            }
        }

        this.sendDataHandler?.(data);
    }

    onKeyHandler(data: { key: string; domEvent: KeyboardEvent }) {
        if (this.multiInputCallback) {
            this.multiInputCallback(data.key);
        }
    }

    addFocusListener(focusFn: () => void) {
        this.terminal.textarea.addEventListener("focus", focusFn);
    }

    getCursorOverlayMetrics(): {
        left: number;
        top: number;
        cellWidth: number;
        cellHeight: number;
        cols: number;
        fontFamily?: string;
        fontSize?: number;
        contentLeft: number;
    } | null {
        const core = (this.terminal as any)?._core;
        const renderService = core?._renderService;
        const dims = renderService?.dimensions;
        const buffer = this.terminal.buffer?.active;

        if (!dims || !buffer) {
            return null;
        }

        const containerRect = this.connectElem.getBoundingClientRect();
        const screenElement = this.connectElem.querySelector(".xterm-screen") as HTMLElement;
        const viewportElement = this.connectElem.querySelector(".xterm-viewport") as HTMLElement;
        const screenRect = screenElement?.getBoundingClientRect();
        const viewportRect = viewportElement?.getBoundingClientRect();

        const contentOffsetLeft = screenRect
            ? screenRect.left - containerRect.left
            : viewportRect
              ? viewportRect.left - containerRect.left
              : 0;
        const contentOffsetTop = screenRect
            ? screenRect.top - containerRect.top
            : viewportRect
              ? viewportRect.top - containerRect.top
              : 0;

        const cursorX = buffer.cursorX ?? 0;
        const cursorY = buffer.cursorY ?? 0;
        const baseY = buffer.baseY ?? 0;
        const ydisp = (buffer as any).ydisp ?? 0;
        const absoluteRow = baseY + cursorY;
        const relativeRow = Math.max(0, absoluteRow - ydisp);

        const cellWidth = dims.actualCellWidth ?? 9;
        const cellHeight = dims.actualCellHeight ?? 16;
        const left = contentOffsetLeft + cursorX * cellWidth;
        const top = contentOffsetTop + relativeRow * cellHeight;

        const fontFamily = this.terminal.options?.fontFamily;
        const fontSize = this.terminal.options?.fontSize;

        return {
            left,
            top,
            cellWidth,
            cellHeight,
            cols: this.terminal.cols ?? 80,
            fontFamily,
            fontSize,
            contentLeft: contentOffsetLeft,
        };
    }

    handleNewFileSubjectData(msg: WSFileEventData) {
        if (msg.fileop == "truncate") {
            this.terminal.clear();
            this.heldData = [];
        } else if (msg.fileop == "append") {
            const decodedData = base64ToArray(msg.data64);
            if (this.loaded) {
                this.doTerminalWrite(decodedData, null);
            } else {
                this.heldData.push(decodedData);
            }
        } else {
            console.log("bad fileop for terminal", msg);
            return;
        }
    }

    doTerminalWrite(data: string | Uint8Array, setPtyOffset?: number): Promise<void> {
        let resolve: () => void = null;
        let prtn = new Promise<void>((presolve, _) => {
            resolve = presolve;
        });
        this.terminal.write(data, () => {
            if (setPtyOffset != null) {
                this.ptyOffset = setPtyOffset;
            } else {
                this.ptyOffset += data.length;
                this.dataBytesProcessed += data.length;
            }
            this.lastUpdated = Date.now();
            resolve();
        });
        return prtn;
    }

    async loadInitialTerminalData(): Promise<void> {
        let startTs = Date.now();
        const { data: cacheData, fileInfo: cacheFile } = await fetchWaveFile(this.blockId, TermCacheFileName);
        let ptyOffset = 0;
        if (cacheFile != null) {
            ptyOffset = cacheFile.meta["ptyoffset"] ?? 0;
            if (cacheData.byteLength > 0) {
                const curTermSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
                const fileTermSize: TermSize = cacheFile.meta["termsize"];
                let didResize = false;
                if (
                    fileTermSize != null &&
                    (fileTermSize.rows != curTermSize.rows || fileTermSize.cols != curTermSize.cols)
                ) {
                    console.log("terminal restore size mismatch, temp resize", fileTermSize, curTermSize);
                    this.terminal.resize(fileTermSize.cols, fileTermSize.rows);
                    didResize = true;
                }
                this.doTerminalWrite(cacheData, ptyOffset);
                if (didResize) {
                    this.terminal.resize(curTermSize.cols, curTermSize.rows);
                }
            }
        }
        const { data: mainData, fileInfo: mainFile } = await fetchWaveFile(this.blockId, TermFileName, ptyOffset);
        console.log(
            `terminal loaded cachefile:${cacheData?.byteLength ?? 0} main:${mainData?.byteLength ?? 0} bytes, ${Date.now() - startTs}ms`
        );
        if (mainFile != null) {
            await this.doTerminalWrite(mainData, null);
        }
    }

    async resyncController(reason: string) {
        dlog("resync controller", this.blockId, reason);
        const tabId = globalStore.get(atoms.staticTabId);
        const rtOpts: RuntimeOpts = { termsize: { rows: this.terminal.rows, cols: this.terminal.cols } };
        try {
            await RpcApi.ControllerResyncCommand(TabRpcClient, {
                tabid: tabId,
                blockid: this.blockId,
                rtopts: rtOpts,
            });
        } catch (e) {
            console.log(`error controller resync (${reason})`, this.blockId, e);
        }
    }

    handleResize() {
        const oldRows = this.terminal.rows;
        const oldCols = this.terminal.cols;
        this.fitAddon.fit();
        if (oldRows !== this.terminal.rows || oldCols !== this.terminal.cols) {
            const termSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
            const wsCommand: SetBlockTermSizeWSCommand = {
                wscommand: "setblocktermsize",
                blockid: this.blockId,
                termsize: termSize,
            };
            sendWSCommand(wsCommand);
        }
        dlog("resize", `${this.terminal.rows}x${this.terminal.cols}`, `${oldRows}x${oldCols}`, this.hasResized);
        if (!this.hasResized) {
            this.hasResized = true;
            this.resyncController("initial resize");
        }
    }

    processAndCacheData() {
        if (this.dataBytesProcessed < MinDataProcessedForCache) {
            return;
        }
        const serializedOutput = this.serializeAddon.serialize();
        const termSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
        console.log("idle timeout term", this.dataBytesProcessed, serializedOutput.length, termSize);
        fireAndForget(() =>
            services.BlockService.SaveTerminalState(this.blockId, serializedOutput, "full", this.ptyOffset, termSize)
        );
        this.dataBytesProcessed = 0;
    }

    runProcessIdleTimeout() {
        setTimeout(() => {
            window.requestIdleCallback(() => {
                this.processAndCacheData();
                this.runProcessIdleTimeout();
            });
        }, 5000);
    }

    async pasteHandler(e?: ClipboardEvent): Promise<void> {
        this.pasteActive = true;
        e?.preventDefault();
        e?.stopPropagation();

        try {
            const clipboardData = await extractAllClipboardData(e);
            let firstImage = true;
            for (const data of clipboardData) {
                if (data.image && SupportsImageInput) {
                    if (!firstImage) {
                        await new Promise((r) => setTimeout(r, 150));
                    }
                    const tempPath = await createTempFileFromBlob(data.image);
                    this.terminal.paste(tempPath + " ");
                    firstImage = false;
                }
                if (data.text) {
                    this.terminal.paste(data.text);
                }
            }
        } catch (err) {
            console.error("Paste error:", err);
        } finally {
            setTimeout(() => {
                this.pasteActive = false;
            }, 30);
        }
    }
}
