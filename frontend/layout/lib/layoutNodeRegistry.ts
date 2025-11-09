import { LayoutNode } from "./types";

const layoutNodeRegistry = new Map<string, LayoutNode>();

export function registerLayoutNode(node: LayoutNode) {
    if (!node?.id) {
        return;
    }
    layoutNodeRegistry.set(node.id, node);
}

export function getRegisteredLayoutNode(id: string): LayoutNode | undefined {
    if (!id) {
        return undefined;
    }
    return layoutNodeRegistry.get(id);
}

export function unregisterLayoutNode(id: string) {
    if (!id) {
        return;
    }
    layoutNodeRegistry.delete(id);
}

