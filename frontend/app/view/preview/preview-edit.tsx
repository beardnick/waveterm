// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/store/global";
import { adaptFromReactOrNativeKeyEvent, checkKeyPressed } from "@/util/keyutil";
import { fireAndForget } from "@/util/util";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { tryReinjectKey } from "@/app/store/keymodel";
import type { SpecializedViewProps } from "./preview";

import "@xterm/xterm/css/xterm.css";

function makeSessionId(blockId: string): string {
    const randomSegment =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2);
    return `neovim-${blockId}-${randomSegment}`;
}

function CodeEditPreview({ model }: SpecializedViewProps) {
    const fileContent = useAtomValue(model.fileContent);
    const fileInfo = useAtomValue(model.statFile);
    const fileName = fileInfo?.path || fileInfo?.name || "buffer";
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal>(null);
    const fitAddonRef = useRef<FitAddon>(null);
    const startedRef = useRef(false);
    const sessionIdRef = useRef<string>("");

    if (!sessionIdRef.current) {
        sessionIdRef.current = makeSessionId(model.blockId);
    }

    useEffect(() => {
        const terminal = new Terminal({
            convertEol: true,
            cursorBlink: true,
            scrollback: 2000,
            fontFamily: "Hack",
            fontSize: 12,
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);

        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        const container = containerRef.current;
        if (container) {
            terminal.open(container);
            fitAddon.fit();
        }

        terminal.attachCustomKeyEventHandler((keyboardEvent) => {
            const waveEvent = adaptFromReactOrNativeKeyEvent(keyboardEvent);
            if (tryReinjectKey(waveEvent)) {
                keyboardEvent.preventDefault();
                keyboardEvent.stopPropagation();
                return false;
            }
            return true;
        });

        const dataDisposable = terminal.onData((data: string) => {
            window.api.sendNeovimInput(sessionIdRef.current, data);
        });

        const resizeObserver = new ResizeObserver(() => {
            if (!terminalRef.current || !fitAddonRef.current) {
                return;
            }
            fitAddonRef.current.fit();
            const cols = terminalRef.current.cols ?? 80;
            const rows = terminalRef.current.rows ?? 24;
            window.api.resizeNeovimSession(sessionIdRef.current, cols, rows);
        });
        if (container) {
            resizeObserver.observe(container);
        }

        const isFocused = globalStore.get(model.nodeModel.isFocused);
        if (isFocused) {
            terminal.focus();
        }

        model.monacoRef.current = {
            focus: () => terminal.focus(),
        };

        return () => {
            model.monacoRef.current = null;
            if (startedRef.current) {
                window.api.stopNeovimSession(sessionIdRef.current);
            }
            dataDisposable.dispose();
            resizeObserver.disconnect();
            terminal.dispose();
            terminalRef.current = null;
            fitAddonRef.current = null;
            startedRef.current = false;
        };
    }, [model]);

    useEffect(() => {
        const handler = (e: WaveKeyboardEvent): boolean => {
            if (checkKeyPressed(e, "Cmd:e")) {
                fireAndForget(() => model.setEditMode(false));
                return true;
            }
            return false;
        };
        model.codeEditKeyDownHandler = handler;
        return () => {
            if (model.codeEditKeyDownHandler === handler) {
                model.codeEditKeyDownHandler = null;
            }
        };
    }, [model]);

    useEffect(() => {
        if (startedRef.current) {
            return;
        }
        if (typeof fileContent !== "string") {
            return;
        }
        if (!terminalRef.current) {
            return;
        }

        startedRef.current = true;
        const cols = terminalRef.current.cols ?? 80;
        const rows = terminalRef.current.rows ?? 24;
        window.api
            .startNeovimSession({
                sessionId: sessionIdRef.current,
                displayName: fileName ?? "buffer",
                initialContent: fileContent ?? "",
                cols,
                rows,
            })
            .catch((err) => {
                console.error("Failed to start Neovim session", err);
            });
    }, [fileContent, fileName]);

    useEffect(() => {
        const disposeData = window.api.onNeovimData((payload) => {
            if (payload.sessionId !== sessionIdRef.current) {
                return;
            }
            if (terminalRef.current) {
                terminalRef.current.write(payload.data);
            }
        });
        const disposeExit = window.api.onNeovimExit((payload) => {
            if (payload.sessionId !== sessionIdRef.current) {
                return;
            }
            fireAndForget(() => model.setEditMode(false));
        });
        const disposeFile = window.api.onNeovimFileChange((payload) => {
            if (payload.sessionId !== sessionIdRef.current) {
                return;
            }
            fireAndForget(() => model.handleNeovimFileWrite(payload.content));
        });
        return () => {
            disposeData();
            disposeExit();
            disposeFile();
        };
    }, [model]);

    return (
        <div className="flex flex-col w-full h-full overflow-hidden">
            <div ref={containerRef} className="flex-1 min-h-0" />
        </div>
    );
}

export { CodeEditPreview };
