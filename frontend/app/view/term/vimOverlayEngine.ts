import { applyVimPaste, YankRegister } from "./vimOverlayUtils";

type VimMode = "insert" | "normal" | "visualLine";
type PendingOperator = "d" | "c" | "y" | "g" | null;
type VisualSelection = { start: number; end: number } | null;

export interface VimBufferState {
    value: string;
    mode: VimMode;
    pendingOperator: PendingOperator;
    register: YankRegister;
    visualAnchor: number | null;
    visualSelection: VisualSelection;
}

export interface VimProcessInput {
    key: string;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
}

export interface VimProcessResult {
    state: VimBufferState;
    cursor: number;
    selectionEnd: number;
    displayCursor: number;
    displaySelectionEnd: number;
    handled: boolean;
    action?: "submit" | "cancel";
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const isWhitespace = (char: string) => /\s/.test(char);

const computeLineStart = (text: string, pos: number) => {
    if (text.length === 0 || pos <= 0) {
        return 0;
    }
    const idx = text.lastIndexOf("\n", Math.min(pos, text.length) - 1);
    return idx === -1 ? 0 : idx + 1;
};

const computeLineEnd = (text: string, pos: number) => {
    if (text.length === 0) {
        return 0;
    }
    const idx = text.indexOf("\n", pos);
    return idx === -1 ? text.length : idx;
};

const computeNextLineStart = (text: string, pos: number) => {
    const endIdx = computeLineEnd(text, pos);
    return endIdx >= text.length ? text.length : endIdx + 1;
};

const computePrevLineStart = (text: string, pos: number) => {
    const startIdx = computeLineStart(text, pos);
    if (startIdx === 0) {
        return 0;
    }
    return computeLineStart(text, startIdx - 1);
};

const computeNextWordStart = (text: string, pos: number) => {
    let i = pos;
    const len = text.length;
    if (i < len) {
        if (!isWhitespace(text[i])) {
            while (i < len && !isWhitespace(text[i])) {
                i++;
            }
        }
        while (i < len && isWhitespace(text[i])) {
            i++;
        }
    }
    return i;
};

const computePrevWordStart = (text: string, pos: number) => {
    let i = pos - 1;
    if (i < 0) {
        return 0;
    }
    while (i >= 0 && isWhitespace(text[i])) {
        i--;
    }
    while (i >= 0 && !isWhitespace(text[i])) {
        i--;
    }
    return Math.max(0, i + 1);
};

const computeWordEnd = (text: string, pos: number) => {
    const len = text.length;
    if (len === 0) {
        return 0;
    }
    let i = pos;
    if (i >= len) {
        return len - 1;
    }
    if (isWhitespace(text[i])) {
        while (i < len && isWhitespace(text[i])) {
            i++;
        }
    }
    if (i >= len) {
        return len - 1;
    }
    while (i < len && !isWhitespace(text[i])) {
        i++;
    }
    return Math.max(0, i - 1);
};

const normalizeSelection = (
    cursor: number,
    selectionEnd: number,
    mode: VimMode,
    valueLength: number,
    visualSelection: VisualSelection
): { cursor: number; selectionEnd: number } => {
    let start = clamp(cursor, 0, valueLength);
    let end = clamp(selectionEnd, 0, valueLength);
    if (mode === "normal") {
        if (valueLength === 0) {
            start = 0;
            end = 0;
        } else {
            start = clamp(start, 0, Math.max(0, valueLength - 1));
            end = clamp(start + 1, start, valueLength);
        }
        return { cursor: start, selectionEnd: end };
    }
    if (mode === "visualLine" && visualSelection) {
        const selStart = clamp(Math.min(visualSelection.start, visualSelection.end), 0, valueLength);
        const selEnd = clamp(Math.max(visualSelection.start, visualSelection.end), selStart, valueLength);
        return { cursor: selStart, selectionEnd: selEnd };
    }
    start = clamp(start, 0, valueLength);
    end = start;
    return { cursor: start, selectionEnd: end };
};

export function processVimKey(
    state: VimBufferState,
    cursor: number,
    selectionEnd: number,
    input: VimProcessInput
): VimProcessResult {
    const currentValue = state.value;
    let newValue = currentValue;
    let newCursor = clamp(cursor, 0, currentValue.length);
    let newSelectionEnd = clamp(selectionEnd, 0, currentValue.length);
    let newMode: VimMode = state.mode;
    let newPending: PendingOperator = state.pendingOperator;
    let newRegister: YankRegister = state.register;
    let newVisualAnchor: number | null = state.visualAnchor ?? null;
    let newVisualSelection: VisualSelection = state.visualSelection ? { ...state.visualSelection } : null;
    let action: "submit" | "cancel" | undefined;

    const setResult = (handled: boolean): VimProcessResult => {
        const { cursor: displayCursor, selectionEnd: displaySelectionEnd } = normalizeSelection(
            newCursor,
            newSelectionEnd,
            newMode,
            newValue.length,
            newVisualSelection
        );
        return {
            state: {
                value: newValue,
                mode: newMode,
                pendingOperator: newPending,
                register: newRegister,
                visualAnchor: newVisualAnchor,
                visualSelection: newVisualSelection,
            },
            cursor: newCursor,
            selectionEnd: newSelectionEnd,
            displayCursor,
            displaySelectionEnd,
            handled,
            action,
        };
    };

    const applyValue = (value: string, cursorPos: number, modeOverride?: VimMode) => {
        newValue = value;
        newCursor = clamp(cursorPos, 0, newValue.length);
        newSelectionEnd = newCursor;
        newMode = modeOverride ?? newMode;
        newPending = null;
        if (newMode !== "visualLine") {
            newVisualAnchor = null;
            newVisualSelection = null;
        }
    };

    const moveCursor = (pos: number) => {
        newCursor = clamp(pos, 0, newValue.length);
        newSelectionEnd = newCursor;
        newPending = null;
        if (newMode === "visualLine") {
            const anchor = newVisualAnchor ?? computeLineStart(newValue, newCursor);
            newVisualAnchor = anchor;
            const anchorStart = computeLineStart(newValue, anchor);
            const targetStart = computeLineStart(newValue, newCursor);
            const selectionStart = Math.min(anchorStart, targetStart);
            const selectionEnd = computeNextLineStart(newValue, Math.max(anchorStart, targetStart));
            newCursor = targetStart;
            newSelectionEnd = selectionEnd;
            newVisualSelection = { start: selectionStart, end: selectionEnd };
        } else {
            newVisualSelection = null;
            newVisualAnchor = null;
        }
    };

    const enterInsertModeAt = (pos: number | null) => {
        newMode = "insert";
        newPending = null;
        newCursor = clamp(pos ?? newCursor, 0, newValue.length);
        newSelectionEnd = newCursor;
        newVisualAnchor = null;
        newVisualSelection = null;
    };

    const startVisualLineAt = (pos: number) => {
        const anchorStart = computeLineStart(newValue, pos);
        newMode = "visualLine";
        newPending = null;
        newVisualAnchor = anchorStart;
        const selectionEnd = computeNextLineStart(newValue, anchorStart);
        newCursor = anchorStart;
        newSelectionEnd = selectionEnd;
        newVisualSelection = { start: anchorStart, end: selectionEnd };
    };

    if (input.key === "Enter" && input.ctrlKey && !input.altKey && !input.metaKey) {
        const start = Math.min(cursor, selectionEnd);
        const end = Math.max(cursor, selectionEnd);
        applyValue(newValue.slice(0, start) + "\n" + newValue.slice(end), start + 1, "insert");
        return setResult(true);
    }

    if (input.key === "Enter" && !input.shiftKey && !input.ctrlKey && !input.altKey && !input.metaKey) {
        action = "submit";
        return setResult(true);
    }

    if (state.mode === "insert") {
        if (input.key === "Escape") {
            newMode = "normal";
            newPending = null;
            const target = Math.max(cursor - 1, 0);
            newCursor = clamp(target, 0, newValue.length);
            newSelectionEnd = newCursor;
            newVisualAnchor = null;
            newVisualSelection = null;
            return setResult(true);
        }
        return setResult(false);
    }

    if (state.mode === "visualLine") {
        const getVisualSelection = () => {
            if (!newVisualSelection) {
                const anchorStart = newVisualAnchor != null ? computeLineStart(newValue, newVisualAnchor) : newCursor;
                const targetStart = computeLineStart(newValue, newCursor);
                const selectionStart = Math.min(anchorStart, targetStart);
                const selectionEnd = computeNextLineStart(newValue, Math.max(anchorStart, targetStart));
                newVisualSelection = { start: selectionStart, end: selectionEnd };
                newVisualAnchor = anchorStart;
            }
            const start = clamp(Math.min(newVisualSelection.start, newVisualSelection.end), 0, newValue.length);
            const end = clamp(Math.max(newVisualSelection.start, newVisualSelection.end), start, newValue.length);
            return { start, end };
        };

        if (input.key === "Escape" || input.key === "V") {
            const anchorStart = newVisualAnchor != null ? computeLineStart(newValue, newVisualAnchor) : newCursor;
            newMode = "normal";
            newPending = null;
            newVisualAnchor = null;
            newVisualSelection = null;
            newCursor = clamp(anchorStart, 0, newValue.length);
            newSelectionEnd = newCursor;
            return setResult(true);
        }

        if (input.key === "y") {
            const { start, end } = getVisualSelection();
            let text = newValue.slice(start, end);
            if (!text.endsWith("\n")) {
                text += "\n";
            }
            newRegister = { text, kind: "line" };
            newMode = "normal";
            newPending = null;
            newVisualAnchor = null;
            newVisualSelection = null;
            newCursor = clamp(start, 0, newValue.length);
            newSelectionEnd = newCursor;
            return setResult(true);
        }

        if (input.key === "d" || input.key === "c") {
            const { start, end } = getVisualSelection();
            let text = newValue.slice(start, end);
            if (!text.endsWith("\n")) {
                text += "\n";
            }
            newRegister = { text, kind: "line" };
            newValue = newValue.slice(0, start) + newValue.slice(end);
            newCursor = clamp(Math.min(start, newValue.length), 0, newValue.length);
            newSelectionEnd = newCursor;
            newVisualAnchor = null;
            newVisualSelection = null;
            if (input.key === "c") {
                newMode = "insert";
            } else {
                newMode = "normal";
            }
            return setResult(true);
        }
    }

    if (state.mode === "normal" && input.key === "Escape") {
        if (state.pendingOperator) {
            newPending = null;
            return setResult(true);
        }
        action = "cancel";
        return setResult(true);
    }

    const lineStart = (pos: number) => computeLineStart(newValue, pos);
    const lineEnd = (pos: number) => computeLineEnd(newValue, pos);
    const nextLineStart = (pos: number) => computeNextLineStart(newValue, pos);
    const prevLineStart = (pos: number) => computePrevLineStart(newValue, pos);
    const nextWordStart = (pos: number) => computeNextWordStart(newValue, pos);
    const prevWordStart = (pos: number) => computePrevWordStart(newValue, pos);
    const wordEnd = (pos: number) => computeWordEnd(newValue, pos);

    const pending = state.pendingOperator;
    if (pending) {
        if (pending === "y") {
            let yankText: string | null = null;
            if (input.key === "y") {
                const startIdx = lineStart(newCursor);
                let endIdx = lineEnd(newCursor);
                if (endIdx < newValue.length) {
                    endIdx += 1;
                } else {
                    endIdx = newValue.length;
                }
                yankText = newValue.slice(startIdx, endIdx);
                if (!yankText.endsWith("\n")) {
                    yankText += "\n";
                }
                newRegister = { text: yankText, kind: "line" };
                newPending = null;
                moveCursor(startIdx);
                return setResult(true);
            } else if (input.key === "w") {
                const target = nextWordStart(newCursor);
                if (target > newCursor) {
                    yankText = newValue.slice(newCursor, target);
                }
            } else if (input.key === "$") {
                const target = lineEnd(newCursor);
                if (target > newCursor) {
                    yankText = newValue.slice(newCursor, target);
                }
            }
            if (yankText != null) {
                newRegister = { text: yankText, kind: "char" };
                newPending = null;
                moveCursor(newCursor);
            } else {
                newPending = null;
            }
            return setResult(true);
        }

        if (pending === "g") {
            newPending = null;
            if (input.key === "g") {
                moveCursor(0);
                return setResult(true);
            }
            return setResult(true);
        }

        const isChange = pending === "c";
        let handled = true;
        let newText = newValue;
        let newCursorPos = newCursor;
        if (input.key === "d") {
            const startIdx = lineStart(newCursor);
            let endIdx = lineEnd(newCursor);
            endIdx = endIdx < newValue.length ? endIdx + 1 : endIdx;
            newRegister = { text: newValue.slice(startIdx, endIdx), kind: "line" };
            newText = newValue.slice(0, startIdx) + newValue.slice(endIdx);
            newCursorPos = Math.min(startIdx, newText.length);
        } else if (input.key === "w") {
            const target = nextWordStart(newCursor);
            if (target > newCursor) {
                newRegister = { text: newValue.slice(newCursor, target), kind: "char" };
                newText = newValue.slice(0, newCursor) + newValue.slice(target);
                newCursorPos = newCursor;
            } else {
                handled = false;
            }
        } else if (input.key === "$") {
            const target = lineEnd(newCursor);
            if (target > newCursor) {
                newRegister = { text: newValue.slice(newCursor, target), kind: "char" };
                newText = newValue.slice(0, newCursor) + newValue.slice(target);
                newCursorPos = newCursor;
            } else {
                handled = false;
            }
        } else {
            handled = false;
        }

        if (handled) {
            applyValue(newText, newCursorPos, isChange ? "insert" : newMode);
        } else {
            newPending = null;
            moveCursor(newCursor);
        }
        return setResult(true);
    }

    switch (input.key) {
        case "d":
        case "c":
        case "y":
            newPending = input.key as "d" | "c" | "y";
            return setResult(true);
        case "g":
            newPending = "g";
            return setResult(true);
        case "D": {
            const startIdx = newCursor;
            const endIdx = lineEnd(newCursor);
            if (endIdx > startIdx) {
                newRegister = { text: newValue.slice(startIdx, endIdx), kind: "char" };
                applyValue(newValue.slice(0, startIdx) + newValue.slice(endIdx), startIdx, "insert");
            } else {
                newPending = null;
            }
            return setResult(true);
        }
        case "h":
            moveCursor(newCursor - 1);
            return setResult(true);
        case "l":
            moveCursor(newCursor + (newCursor < newValue.length ? 1 : 0));
            return setResult(true);
        case "0":
            moveCursor(lineStart(newCursor));
            return setResult(true);
        case "$":
            moveCursor(lineEnd(newCursor));
            return setResult(true);
        case "w":
            moveCursor(nextWordStart(newCursor));
            return setResult(true);
        case "e":
            moveCursor(wordEnd(newCursor));
            return setResult(true);
        case "b":
            moveCursor(prevWordStart(newCursor));
            return setResult(true);
        case "j": {
            const startIdx = lineStart(newCursor);
            const col = newCursor - startIdx;
            const nextStart = nextLineStart(newCursor);
            if (nextStart === newValue.length) {
                moveCursor(newValue.length);
                return setResult(true);
            }
            const nextEnd = lineEnd(nextStart);
            moveCursor(Math.min(nextStart + col, nextEnd));
            return setResult(true);
        }
        case "k": {
            const startIdx = lineStart(newCursor);
            const col = newCursor - startIdx;
            const prevStart = prevLineStart(newCursor);
            if (prevStart === startIdx) {
                moveCursor(startIdx);
                return setResult(true);
            }
            const prevEnd = lineEnd(prevStart);
            moveCursor(Math.min(prevStart + col, prevEnd));
            return setResult(true);
        }
        case "x":
            if (newCursor < newValue.length) {
                newRegister = { text: newValue.slice(newCursor, newCursor + 1), kind: "char" };
                applyValue(newValue.slice(0, newCursor) + newValue.slice(newCursor + 1), newCursor);
            }
            return setResult(true);
        case "p": {
            const result = applyVimPaste(newValue, newCursor, newRegister);
            newValue = result.value;
            newMode = result.mode;
            newPending = null;
            newCursor = clamp(result.cursor, 0, newValue.length);
            newSelectionEnd = newCursor;
            newVisualAnchor = null;
            newVisualSelection = null;
            return setResult(true);
        }
        case "i":
            enterInsertModeAt(newCursor);
            return setResult(true);
        case "I": {
            const startIdx = lineStart(newCursor);
            enterInsertModeAt(startIdx);
            return setResult(true);
        }
        case "a":
        case "A": {
            const insertPos =
                input.key === "A" ? lineEnd(newCursor) : newCursor + (newCursor < newValue.length ? 1 : 0);
            enterInsertModeAt(insertPos);
            return setResult(true);
        }
        case "o": {
            const currentLineStart = lineStart(newCursor);
            const currentLineEnd = lineEnd(newCursor);
            const indentMatch = newValue.slice(currentLineStart, currentLineEnd).match(/^\s*/);
            const indent = indentMatch?.[0] ?? "";
            const insertionPoint = lineEnd(newCursor);
            const insertion = "\n" + indent;
            applyValue(
                newValue.slice(0, insertionPoint) + insertion + newValue.slice(insertionPoint),
                insertionPoint + 1 + indent.length,
                "insert"
            );
            return setResult(true);
        }
        case "O": {
            const currentLineStart = lineStart(newCursor);
            const currentLineEnd = lineEnd(newCursor);
            const indentMatch = newValue.slice(currentLineStart, currentLineEnd).match(/^\s*/);
            const indent = indentMatch?.[0] ?? "";
            const insertion = indent + "\n";
            applyValue(
                newValue.slice(0, currentLineStart) + insertion + newValue.slice(currentLineStart),
                currentLineStart + indent.length,
                "insert"
            );
            return setResult(true);
        }
        case "G": {
            const lastLineStart =
                newValue.length === 0 ? 0 : computeLineStart(newValue, Math.max(newValue.length - 1, 0));
            moveCursor(lastLineStart);
            return setResult(true);
        }
        case "V":
            startVisualLineAt(newCursor);
            return setResult(true);
        default:
            newPending = null;
            return setResult(true);
    }
}
