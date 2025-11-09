// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Block, SubBlock } from "@/app/block/block";
import { Search, useSearch } from "@/app/element/search";
import { waveEventSubscribe } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { TermViewModel } from "@/app/view/term/term-model";
import { atoms, getOverrideConfigAtom, getSettingsPrefixAtom, globalStore, WOS } from "@/store/global";
import { fireAndForget, useAtomValueSafe } from "@/util/util";
import { computeBgStyleFromMeta } from "@/util/waveutil";
import { ISearchOptions } from "@xterm/addon-search";
import clsx from "clsx";
import debug from "debug";
import * as jotai from "jotai";
import * as React from "react";
import { TermStickers } from "./termsticker";
import { TermThemeUpdater } from "./termtheme";
import { computeTheme } from "./termutil";
import { TermWrap } from "./termwrap";
import { processVimKey } from "./vimOverlayEngine";
import { YankRegister } from "./vimOverlayUtils";
import "./xterm.css";

const dlog = debug("wave:term");

type InitialLoadDataType = {
    loaded: boolean;
    heldData: Uint8Array[];
};

interface TerminalViewProps {
    blockId: string;
    model: TermViewModel;
}

type TermInputOverlayState = {
    active: boolean;
    value: string;
    position: { top: number; left: number; contentLeft: number };
    cell: { width: number; height: number; cols: number };
    font: { family?: string; size?: number };
    mode: "insert" | "normal" | "visualLine";
    pendingOperator: "d" | "c" | "y" | "g" | null;
    visualAnchor: number | null;
    visualSelection: { start: number; end: number } | null;
    cursor: number;
    selectionEnd: number;
};

const TermResyncHandler = React.memo(({ blockId, model }: TerminalViewProps) => {
    const connStatus = jotai.useAtomValue(model.connStatus);
    const [lastConnStatus, setLastConnStatus] = React.useState<ConnStatus>(connStatus);

    React.useEffect(() => {
        if (!model.termRef.current?.hasResized) {
            return;
        }
        const isConnected = connStatus?.status == "connected";
        const wasConnected = lastConnStatus?.status == "connected";
        const curConnName = connStatus?.connection;
        const lastConnName = lastConnStatus?.connection;
        if (isConnected == wasConnected && curConnName == lastConnName) {
            return;
        }
        model.termRef.current?.resyncController("resync handler");
        setLastConnStatus(connStatus);
    }, [connStatus]);

    return null;
});

const TermVDomToolbarNode = ({ vdomBlockId, blockId, model }: TerminalViewProps & { vdomBlockId: string }) => {
    React.useEffect(() => {
        const unsub = waveEventSubscribe({
            eventType: "blockclose",
            scope: WOS.makeORef("block", vdomBlockId),
            handler: (event) => {
                RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("block", blockId),
                    meta: {
                        "term:mode": null,
                        "term:vdomtoolbarblockid": null,
                    },
                });
            },
        });
        return () => {
            unsub();
        };
    }, []);
    let vdomNodeModel = {
        blockId: vdomBlockId,
        isFocused: jotai.atom(false),
        focusNode: () => {},
        onClose: () => {
            if (vdomBlockId != null) {
                RpcApi.DeleteSubBlockCommand(TabRpcClient, { blockid: vdomBlockId });
            }
        },
    };
    const toolbarTarget = jotai.useAtomValue(model.vdomToolbarTarget);
    const heightStr = toolbarTarget?.height ?? "1.5em";
    return (
        <div key="vdomToolbar" className="term-toolbar" style={{ height: heightStr }}>
            <SubBlock key="vdom" nodeModel={vdomNodeModel} />
        </div>
    );
};

const TermVDomNodeSingleId = ({ vdomBlockId, blockId, model }: TerminalViewProps & { vdomBlockId: string }) => {
    React.useEffect(() => {
        const unsub = waveEventSubscribe({
            eventType: "blockclose",
            scope: WOS.makeORef("block", vdomBlockId),
            handler: (event) => {
                RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("block", blockId),
                    meta: {
                        "term:mode": null,
                        "term:vdomblockid": null,
                    },
                });
            },
        });
        return () => {
            unsub();
        };
    }, []);
    const isFocusedAtom = jotai.atom((get) => {
        return get(model.nodeModel.isFocused) && get(model.termMode) == "vdom";
    });
    let vdomNodeModel = {
        blockId: vdomBlockId,
        isFocused: isFocusedAtom,
        focusNode: () => {
            model.nodeModel.focusNode();
        },
        onClose: () => {
            if (vdomBlockId != null) {
                RpcApi.DeleteSubBlockCommand(TabRpcClient, { blockid: vdomBlockId });
            }
        },
    };
    return (
        <div key="htmlElem" className="term-htmlelem">
            <SubBlock key="vdom" nodeModel={vdomNodeModel} />
        </div>
    );
};

const TermVDomNode = ({ blockId, model }: TerminalViewProps) => {
    const vdomBlockId = jotai.useAtomValue(model.vdomBlockId);
    if (vdomBlockId == null) {
        return null;
    }
    return <TermVDomNodeSingleId key={vdomBlockId} vdomBlockId={vdomBlockId} blockId={blockId} model={model} />;
};

const TermToolbarVDomNode = ({ blockId, model }: TerminalViewProps) => {
    const vdomToolbarBlockId = jotai.useAtomValue(model.vdomToolbarBlockId);
    if (vdomToolbarBlockId == null) {
        return null;
    }
    return (
        <TermVDomToolbarNode
            key={vdomToolbarBlockId}
            vdomBlockId={vdomToolbarBlockId}
            blockId={blockId}
            model={model}
        />
    );
};

const TerminalView = ({ blockId, model }: ViewComponentProps<TermViewModel>) => {
    const viewRef = React.useRef<HTMLDivElement>(null);
    const connectElemRef = React.useRef<HTMLDivElement>(null);
    const [blockData] = WOS.useWaveObjectValue<Block>(WOS.makeORef("block", blockId));
    const termSettingsAtom = getSettingsPrefixAtom("term");
    const termSettings = jotai.useAtomValue(termSettingsAtom);
    const termFontFamilySetting = termSettings?.["term:fontfamily"];
    let termMode = blockData?.meta?.["term:mode"] ?? "term";
    if (termMode != "term" && termMode != "vdom") {
        termMode = "term";
    }
    const termModeRef = React.useRef(termMode);

    const termFontSize = jotai.useAtomValue(model.fontSizeAtom);
    const fullConfig = globalStore.get(atoms.fullConfigAtom);
    const connFontFamily = fullConfig.connections?.[blockData?.meta?.connection]?.["term:fontfamily"];
    const isFocused = jotai.useAtomValue(model.nodeModel.isFocused);
    const isMI = jotai.useAtomValue(atoms.isTermMultiInput);
    const isBasicTerm = termMode != "vdom" && blockData?.meta?.controller != "cmd"; // needs to match isBasicTerm

    const [overlayState, setOverlayState] = React.useState<TermInputOverlayState>({
        active: false,
        value: "",
        position: { top: 0, left: 0, contentLeft: 0 },
        cell: { width: 9, height: 16, cols: 120 },
        font: { family: termFontFamilySetting ?? connFontFamily, size: termFontSize },
        mode: "insert",
        pendingOperator: null,
        visualAnchor: null,
        visualSelection: null,
        cursor: 0,
        selectionEnd: 0,
    });
    const overlayTextareaRef = React.useRef<HTMLTextAreaElement>(null);
    const overlayStateRef = React.useRef<TermInputOverlayState>(overlayState);
    const overlayOriginalInputRef = React.useRef<string>("");
    const overlayYankRegisterRef = React.useRef<YankRegister>(null);

    React.useEffect(() => {
        overlayStateRef.current = overlayState;
    }, [overlayState]);

    const scheduleCursorUpdate = React.useCallback(
        (position: number, modeOverride?: "insert" | "normal" | "visualLine") => {
            requestAnimationFrame(() => {
                const textarea = overlayTextareaRef.current;
                if (!textarea) {
                    return;
                }
                const value = textarea.value ?? "";
                const currentState = overlayStateRef.current;
                const mode = modeOverride ?? currentState.mode ?? "insert";
                const clampVal = (num: number, min: number, max: number) => Math.min(Math.max(num, min), max);
                if (mode === "normal") {
                    textarea.style.caretColor = "transparent";
                    if (value.length === 0) {
                        textarea.setSelectionRange(0, 0);
                        return;
                    }
                    let start = clampVal(position, 0, Math.max(0, value.length - 1));
                    if (start >= value.length) {
                        start = Math.max(0, value.length - 1);
                    }
                    const end = Math.min(value.length, start + 1);
                    textarea.setSelectionRange(start, end);
                } else if (mode === "visualLine") {
                    textarea.style.caretColor = "transparent";
                    const selection = currentState.visualSelection;
                    if (selection) {
                        const start = clampVal(Math.min(selection.start, selection.end), 0, value.length);
                        const end = clampVal(Math.max(selection.start, selection.end), start, value.length);
                        textarea.setSelectionRange(start, end);
                    } else {
                        const caret = clampVal(position, 0, value.length);
                        textarea.setSelectionRange(caret, caret);
                    }
                } else {
                    textarea.style.caretColor = "var(--term-foreground)";
                    const caret = clampVal(position, 0, value.length);
                    textarea.setSelectionRange(caret, caret);
                }
            });
        },
        []
    );

    const handleBeforeSendInput = React.useCallback(
        (data: string) => {
            model.recordUserInput(data);
        },
        [model]
    );

    const handleInterceptInput = React.useCallback((data: string) => {
        if (!overlayStateRef.current.active) {
            return false;
        }
        // When the overlay is active we fully manage the input within the textarea,
        // so prevent data from reaching the underlying PTY.
        return true;
    }, []);

    const updateOverlayPosition = React.useCallback(() => {
        const termWrap = model.termRef.current;
        if (!termWrap || !overlayStateRef.current.active) {
            return;
        }
        const metrics = termWrap.getCursorOverlayMetrics();
        if (!metrics) {
            return;
        }
        setOverlayState((prev) => {
            if (!prev.active) {
                return prev;
            }
            return {
                ...prev,
                position: {
                    top: metrics.top ?? prev.position.top,
                    left: metrics.left ?? prev.position.left,
                    contentLeft: metrics.contentLeft ?? prev.position.contentLeft ?? 0,
                },
                cell: {
                    width: metrics.cellWidth || prev.cell.width,
                    height: metrics.cellHeight || prev.cell.height,
                    cols: metrics.cols || prev.cell.cols,
                },
                font: {
                    family: metrics.fontFamily ?? prev.font.family,
                    size: metrics.fontSize ?? prev.font.size,
                },
            };
        });
    }, [model]);

    const openOverlay = React.useCallback(
        (initialValue: string) => {
            const termWrap = model.termRef.current;
            if (!termWrap) {
                return;
            }
            const existingValue = initialValue ?? "";
            model.setOverlayActive(true);
            model.setCurrentInputBuffer(existingValue);
            overlayOriginalInputRef.current = existingValue;
            const charArray = Array.from(existingValue);
            if (charArray.length > 0) {
                model.sendBackspaces(charArray.length);
            }
            const metrics = termWrap.getCursorOverlayMetrics();
            const fallback = overlayStateRef.current;
            const cellWidth = metrics?.cellWidth || fallback.cell.width;
            const cellHeight = metrics?.cellHeight || fallback.cell.height;
            const cols = metrics?.cols || termWrap.terminal?.cols || fallback.cell.cols;
            const left = metrics?.left ?? fallback.position.left;
            const top = metrics?.top ?? fallback.position.top;
            const contentLeft = metrics?.contentLeft ?? fallback.position.contentLeft ?? 0;
            const fontFamily = metrics?.fontFamily ?? termFontFamilySetting ?? connFontFamily ?? fallback.font.family;
            const fontSize = metrics?.fontSize ?? termFontSize ?? fallback.font.size;
            setOverlayState({
                active: true,
                value: existingValue,
                position: { top, left, contentLeft },
                cell: { width: cellWidth, height: cellHeight, cols },
                font: { family: fontFamily, size: fontSize },
                mode: "insert",
                pendingOperator: null,
                visualAnchor: null,
                visualSelection: null,
                cursor: existingValue.length,
                selectionEnd: existingValue.length,
            });
            requestAnimationFrame(() => {
                if (overlayTextareaRef.current) {
                    overlayTextareaRef.current.focus();
                    scheduleCursorUpdate(existingValue.length, "insert");
                }
            });
            termWrap.terminal.blur?.();
            requestAnimationFrame(() => updateOverlayPosition());
        },
        [model, termFontFamilySetting, connFontFamily, termFontSize, updateOverlayPosition, scheduleCursorUpdate]
    );

    const closeOverlay = React.useCallback(
        (action: "submit" | "cancel") => {
            const latestValue = overlayStateRef.current.value ?? "";
            const originalValue = overlayOriginalInputRef.current;
            overlayOriginalInputRef.current = "";
            setOverlayState((prev) => ({
                ...prev,
                active: false,
                value: "",
                mode: "insert",
                pendingOperator: null,
                visualAnchor: null,
                visualSelection: null,
                cursor: 0,
                selectionEnd: 0,
            }));
            model.setOverlayActive(false);
            if (action === "submit") {
                model.submitOverlayInput(latestValue);
            } else if (action === "cancel" && originalValue) {
                model.sendOverlayTextWithoutSubmit(originalValue);
            }
            requestAnimationFrame(() => {
                model.termRef.current?.terminal.focus();
            });
        },
        [model]
    );

    const handleOverlayChange = React.useCallback(
        (event: React.ChangeEvent<HTMLTextAreaElement>) => {
            const value = event.target.value;
            const selectionStart = event.target.selectionStart ?? value.length;
            const selectionEnd = event.target.selectionEnd ?? selectionStart;
            setOverlayState((prev) => ({
                ...prev,
                value,
                pendingOperator: null,
                visualAnchor: null,
                visualSelection: null,
                cursor: selectionStart,
                selectionEnd,
            }));
            model.setCurrentInputBuffer(value);
        },
        [model]
    );

    const handleOverlayKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
            const textarea = overlayTextareaRef.current;
            if (!textarea) {
                return;
            }
            const selectionStart = textarea.selectionStart ?? 0;
            const selectionEnd = textarea.selectionEnd ?? selectionStart;
            const currentState = overlayStateRef.current;
            const effectiveCursor = currentState.mode === "insert" ? selectionStart : currentState.cursor;
            const effectiveSelectionEnd = currentState.mode === "insert" ? selectionEnd : currentState.selectionEnd;

            const result = processVimKey(
                {
                    value: textarea.value ?? "",
                    mode: currentState.mode,
                    pendingOperator: currentState.pendingOperator,
                    register: overlayYankRegisterRef.current,
                    visualAnchor: currentState.visualAnchor,
                    visualSelection: currentState.visualSelection,
                },
                effectiveCursor,
                effectiveSelectionEnd,
                {
                    key: event.key,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                    altKey: event.altKey,
                    metaKey: event.metaKey,
                }
            );

            if (!result.handled) {
                return;
            }

            event.preventDefault();

            overlayYankRegisterRef.current = result.state.register;
            const nextOverlayState: TermInputOverlayState = {
                value: result.state.value,
                mode: result.state.mode,
                pendingOperator: result.state.pendingOperator,
                visualAnchor: result.state.visualAnchor,
                visualSelection: result.state.visualSelection,
                active: currentState.active,
                position: currentState.position,
                cell: currentState.cell,
                font: currentState.font,
                cursor: result.cursor,
                selectionEnd: result.selectionEnd,
            };
            overlayStateRef.current = nextOverlayState;
            setOverlayState(nextOverlayState);
            model.setCurrentInputBuffer(result.state.value);

            textarea.value = result.state.value;
            const displayCursor =
                result.state.mode === "visualLine" && result.state.visualSelection
                    ? Math.min(result.state.visualSelection.start, result.state.visualSelection.end)
                    : result.displayCursor;
            const displaySelectionEnd =
                result.state.mode === "visualLine" && result.state.visualSelection
                    ? Math.max(result.state.visualSelection.start, result.state.visualSelection.end)
                    : result.displaySelectionEnd;
            textarea.setSelectionRange(displayCursor, displaySelectionEnd);
            scheduleCursorUpdate(displayCursor, result.state.mode);

            if (result.action === "submit") {
                closeOverlay("submit");
            } else if (result.action === "cancel") {
                closeOverlay("cancel");
            }
        },
        [closeOverlay, model, scheduleCursorUpdate]
    );

    React.useEffect(() => {
        model.registerInputOverlayHandlers({ openOverlay });
        return () => {
            model.registerInputOverlayHandlers(null);
        };
    }, [model, openOverlay]);

    React.useEffect(() => {
        if (!overlayState.active) {
            return;
        }
        updateOverlayPosition();
        const termWrap = model.termRef.current;
        if (!termWrap) {
            return;
        }
        const scrollDisposable = termWrap.terminal.onScroll(updateOverlayPosition);
        const renderDisposable = termWrap.terminal.onRender(updateOverlayPosition);
        const resizeDisposable = termWrap.terminal.onResize(updateOverlayPosition);
        const handleWindowResize = () => updateOverlayPosition();
        window.addEventListener("resize", handleWindowResize);
        return () => {
            window.removeEventListener("resize", handleWindowResize);
            try {
                scrollDisposable?.dispose();
            } catch (_) {}
            try {
                renderDisposable?.dispose();
            } catch (_) {}
            try {
                resizeDisposable?.dispose();
            } catch (_) {}
        };
    }, [model, overlayState.active, updateOverlayPosition]);

    React.useEffect(() => {
        if (!overlayState.active) {
            return;
        }
        const textarea = overlayTextareaRef.current;
        if (!textarea) {
            return;
        }
        const pos = textarea.selectionStart ?? overlayState.value.length;
        scheduleCursorUpdate(pos, overlayState.mode);
    }, [overlayState.mode, overlayState.active, overlayState.value.length, scheduleCursorUpdate]);

    let overlayStyle: React.CSSProperties | undefined;
    if (overlayState.active) {
        const terminal = model.termRef.current?.terminal;
        const effectiveCols = Math.max(terminal?.cols ?? overlayState.cell.cols ?? 80, 1);
        const effectiveRows = Math.max(terminal?.rows ?? 24, 1);
        const cellWidth = overlayState.cell.width || 9;
        const cellHeight = overlayState.cell.height || 16;
        const lines = overlayState.value.split(/\r?\n/);
        const lineCount = Math.max(lines.length, 1);
        const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
        const basePaddingX = 6;
        const basePaddingY = 4;
        const container = connectElemRef.current;
        const containerRect = container?.getBoundingClientRect();
        const containerWidth = containerRect?.width ?? cellWidth * effectiveCols;
        const containerHeight = containerRect?.height ?? cellHeight * effectiveRows;
        const contentOffsetLeft = overlayState.position.contentLeft ?? 0;
        const maxWidthPx = Math.max(containerWidth - contentOffsetLeft, cellWidth * 2);
        const desiredWidthPx = maxWidthPx;
        const minWidthPx = Math.min(Math.max(cellWidth * 10, 240), maxWidthPx);
        const widthPx = Math.min(Math.max(desiredWidthPx, minWidthPx), maxWidthPx);
        const paddingAdjustment = 12;
        const minHeightPx = cellHeight + paddingAdjustment;
        const maxHeightPx = containerHeight;
        const baseHeightPx = lineCount * cellHeight + paddingAdjustment;
        const heightPx = Math.min(Math.max(baseHeightPx, minHeightPx), maxHeightPx);
        let top = overlayState.position.top ?? 0;
        if (top + heightPx > containerHeight) {
            top = Math.max(0, containerHeight - heightPx);
        }
        overlayStyle = {
            top,
            left: contentOffsetLeft,
            width: widthPx,
            height: heightPx,
            minHeight: minHeightPx,
            lineHeight: `${cellHeight}px`,
            fontFamily: overlayState.font.family ?? termFontFamilySetting ?? connFontFamily ?? "Hack",
            fontSize: overlayState.font.size ?? termFontSize,
            maxHeight: maxHeightPx,
            maxWidth: maxWidthPx,
            paddingTop: basePaddingY,
            paddingBottom: basePaddingY,
            paddingRight: basePaddingX,
            paddingLeft: basePaddingX,
        };
    }

    // search
    const searchProps = useSearch({
        anchorRef: viewRef,
        viewModel: model,
        caseSensitive: false,
        wholeWord: false,
        regex: false,
    });
    const searchIsOpen = jotai.useAtomValue<boolean>(searchProps.isOpen);
    const caseSensitive = useAtomValueSafe<boolean>(searchProps.caseSensitive);
    const wholeWord = useAtomValueSafe<boolean>(searchProps.wholeWord);
    const regex = useAtomValueSafe<boolean>(searchProps.regex);
    const searchVal = jotai.useAtomValue<string>(searchProps.searchValue);
    const searchDecorations = React.useMemo(
        () => ({
            matchOverviewRuler: "#000000",
            activeMatchColorOverviewRuler: "#000000",
            activeMatchBorder: "#FF9632",
            matchBorder: "#FFFF00",
        }),
        []
    );
    const searchOpts = React.useMemo<ISearchOptions>(
        () => ({
            regex,
            wholeWord,
            caseSensitive,
            decorations: searchDecorations,
        }),
        [regex, wholeWord, caseSensitive]
    );
    const handleSearchError = React.useCallback((e: Error) => {
        console.warn("search error:", e);
    }, []);
    const executeSearch = React.useCallback(
        (searchText: string, direction: "next" | "previous") => {
            if (searchText === "") {
                model.termRef.current?.searchAddon.clearDecorations();
                return;
            }
            try {
                model.termRef.current?.searchAddon[direction === "next" ? "findNext" : "findPrevious"](
                    searchText,
                    searchOpts
                );
            } catch (e) {
                handleSearchError(e);
            }
        },
        [searchOpts, handleSearchError]
    );
    searchProps.onSearch = React.useCallback(
        (searchText: string) => executeSearch(searchText, "previous"),
        [executeSearch]
    );
    searchProps.onPrev = React.useCallback(() => executeSearch(searchVal, "previous"), [executeSearch, searchVal]);
    searchProps.onNext = React.useCallback(() => executeSearch(searchVal, "next"), [executeSearch, searchVal]);
    // Return input focus to the terminal when the search is closed
    React.useEffect(() => {
        if (!searchIsOpen) {
            model.giveFocus();
        }
    }, [searchIsOpen]);
    // rerun search when the searchOpts change
    React.useEffect(() => {
        model.termRef.current?.searchAddon.clearDecorations();
        searchProps.onSearch(searchVal);
    }, [searchOpts]);
    // end search

    React.useEffect(() => {
        const fullConfig = globalStore.get(atoms.fullConfigAtom);
        const termThemeName = globalStore.get(model.termThemeNameAtom);
        const termTransparency = globalStore.get(model.termTransparencyAtom);
        const termBPMAtom = getOverrideConfigAtom(blockId, "term:allowbracketedpaste");
        const [termTheme, _] = computeTheme(fullConfig, termThemeName, termTransparency);
        let termScrollback = 2000;
        if (termSettings?.["term:scrollback"]) {
            termScrollback = Math.floor(termSettings["term:scrollback"]);
        }
        if (blockData?.meta?.["term:scrollback"]) {
            termScrollback = Math.floor(blockData.meta["term:scrollback"]);
        }
        if (termScrollback < 0) {
            termScrollback = 0;
        }
        if (termScrollback > 50000) {
            termScrollback = 50000;
        }
        const termAllowBPM = globalStore.get(termBPMAtom) ?? false;
        const wasFocused = model.termRef.current != null && globalStore.get(model.nodeModel.isFocused);
        const termWrap = new TermWrap(
            blockId,
            connectElemRef.current,
            {
                theme: termTheme,
                fontSize: termFontSize,
                fontFamily: termSettings?.["term:fontfamily"] ?? connFontFamily ?? "Hack",
                drawBoldTextInBrightColors: false,
                fontWeight: "normal",
                fontWeightBold: "bold",
                allowTransparency: true,
                scrollback: termScrollback,
                allowProposedApi: true, // Required by @xterm/addon-search to enable search functionality and decorations
                ignoreBracketedPasteMode: !termAllowBPM,
            },
            {
                keydownHandler: model.handleTerminalKeydown.bind(model),
                useWebGl: !termSettings?.["term:disablewebgl"],
                sendDataHandler: model.sendDataToController.bind(model),
            }
        );
        (window as any).term = termWrap;
        model.termRef.current = termWrap;
        termWrap.beforeSendInputCallback = handleBeforeSendInput;
        termWrap.inputInterceptionCallback = handleInterceptInput;
        const rszObs = new ResizeObserver(() => {
            termWrap.handleResize_debounced();
        });
        rszObs.observe(connectElemRef.current);
        termWrap.onSearchResultsDidChange = (results) => {
            globalStore.set(searchProps.resultsIndex, results.resultIndex);
            globalStore.set(searchProps.resultsCount, results.resultCount);
        };
        fireAndForget(termWrap.initTerminal.bind(termWrap));
        if (wasFocused) {
            setTimeout(() => {
                model.giveFocus();
            }, 10);
        }
        return () => {
            termWrap.beforeSendInputCallback = undefined;
            termWrap.inputInterceptionCallback = undefined;
            termWrap.dispose();
            rszObs.disconnect();
        };
    }, [blockId, termSettings, termFontSize, connFontFamily, handleBeforeSendInput, handleInterceptInput]);

    React.useEffect(() => {
        if (termModeRef.current == "vdom" && termMode == "term") {
            // focus the terminal
            model.giveFocus();
        }
        termModeRef.current = termMode;
    }, [termMode]);

    React.useEffect(() => {
        if (isMI && isBasicTerm && isFocused && model.termRef.current != null) {
            model.termRef.current.multiInputCallback = (data: string) => {
                model.multiInputHandler(data);
            };
        } else {
            if (model.termRef.current != null) {
                model.termRef.current.multiInputCallback = null;
            }
        }
    }, [isMI, isBasicTerm, isFocused]);

    const scrollbarHideObserverRef = React.useRef<HTMLDivElement>(null);
    const onScrollbarShowObserver = React.useCallback(() => {
        const termViewport = viewRef.current.getElementsByClassName("xterm-viewport")[0] as HTMLDivElement;
        termViewport.style.zIndex = "var(--zindex-xterm-viewport-overlay)";
        scrollbarHideObserverRef.current.style.display = "block";
    }, []);
    const onScrollbarHideObserver = React.useCallback(() => {
        const termViewport = viewRef.current.getElementsByClassName("xterm-viewport")[0] as HTMLDivElement;
        termViewport.style.zIndex = "auto";
        scrollbarHideObserverRef.current.style.display = "none";
    }, []);

    const stickerConfig = {
        charWidth: 8,
        charHeight: 16,
        rows: model.termRef.current?.terminal.rows ?? 24,
        cols: model.termRef.current?.terminal.cols ?? 80,
        blockId: blockId,
    };

    const termBg = computeBgStyleFromMeta(blockData?.meta);

    return (
        <div className={clsx("view-term", "term-mode-" + termMode)} ref={viewRef}>
            {termBg && <div className="absolute inset-0 z-0 pointer-events-none" style={termBg} />}
            <TermResyncHandler blockId={blockId} model={model} />
            <TermThemeUpdater blockId={blockId} model={model} termRef={model.termRef} />
            <TermStickers config={stickerConfig} />
            <TermToolbarVDomNode key="vdom-toolbar" blockId={blockId} model={model} />
            <TermVDomNode key="vdom" blockId={blockId} model={model} />
            <div key="conntectElem" className="term-connectelem" ref={connectElemRef}>
                <div className="term-scrollbar-show-observer" onPointerOver={onScrollbarShowObserver} />
                <div
                    ref={scrollbarHideObserverRef}
                    className="term-scrollbar-hide-observer"
                    onPointerOver={onScrollbarHideObserver}
                />
                {overlayState.active && overlayStyle && (
                    <textarea
                        ref={overlayTextareaRef}
                        className={clsx("term-input-overlay", overlayState.mode === "normal" && "vim-normal")}
                        value={overlayState.value}
                        onChange={handleOverlayChange}
                        onKeyDown={handleOverlayKeyDown}
                        spellCheck={false}
                        style={overlayStyle}
                    />
                )}
            </div>
            <Search {...searchProps} />
        </div>
    );
};

export { TerminalView };
