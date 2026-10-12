import { useCallback, useEffect, useRef, useState } from "react";
import { type DropPosition, postHistoryId } from "./order";
import type { Draft, Prompt } from "./types";

type DropTarget = { id: string; position: DropPosition };
type PointerDrag = {
  pointerId: number;
  id: string;
  handle: HTMLButtonElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
};

function edgeScroll(y: number, top: number, bottom: number): number {
  const edge = Math.min(48, (bottom - top) / 3);
  if (y < top || y > bottom || edge <= 0) return 0;
  if (y < top + edge) return -Math.ceil(14 * (1 - (y - top) / edge));
  if (y > bottom - edge) return Math.ceil(14 * (1 - (bottom - y) / edge));
  return 0;
}

export function PromptList({
  prompts,
  drafts,
  selectedId,
  disabled,
  onSelect,
  onMove,
}: {
  prompts: Prompt[];
  drafts: Record<string, Draft>;
  selectedId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onMove: (movingId: string, targetId: string, position: DropPosition) => void;
}) {
  const pointerDrag = useRef<PointerDrag | null>(null);
  const animationFrame = useRef<number | null>(null);
  const list = useRef<HTMLOListElement | null>(null);
  const keyboardFocus = useRef<{ id: string; button: HTMLButtonElement } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const clearDrag = useCallback((resetUI = true) => {
    const session = pointerDrag.current;
    pointerDrag.current = null;
    if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    animationFrame.current = null;
    if (session?.handle.hasPointerCapture(session.pointerId))
      session.handle.releasePointerCapture(session.pointerId);
    if (resetUI) {
      setDraggingId(null);
      setDropTarget(null);
    }
  }, []);

  const findTarget = useCallback((session: PointerDrag): DropTarget | null => {
    const container = list.current;
    if (!container) return null;
    const bounds = container.getBoundingClientRect();
    if (
      session.x < bounds.left ||
      session.x > bounds.right ||
      session.y < Math.max(0, bounds.top) ||
      session.y > Math.min(window.innerHeight, bounds.bottom)
    )
      return null;

    let row = document
      .elementFromPoint(session.x, session.y)
      ?.closest<HTMLLIElement>("li[data-prompt-id]");
    if (!row || !container.contains(row)) {
      // Padding between rows is still a useful drop area; choose the nearest row.
      const rows = Array.from(container.querySelectorAll<HTMLLIElement>("li[data-prompt-id]"));
      row = rows.find((item) => session.y <= item.getBoundingClientRect().bottom) ?? rows.at(-1);
    }
    const id = row?.dataset.promptId;
    if (!row || !id || id === session.id) return null;
    const rowBounds = row.getBoundingClientRect();
    return {
      id,
      position:
        id === postHistoryId || session.y < rowBounds.top + rowBounds.height / 2
          ? "before"
          : "after",
    };
  }, []);

  const updateTarget = useCallback(
    (session: PointerDrag) => {
      const next = findTarget(session);
      setDropTarget((current) =>
        current?.id === next?.id && current?.position === next?.position ? current : next,
      );
    },
    [findTarget],
  );

  const trackDrag = useCallback(
    function tick() {
      const session = pointerDrag.current;
      const container = list.current;
      if (!session?.active || !container) return;
      const bounds = container.getBoundingClientRect();
      if (session.x >= bounds.left && session.x <= bounds.right) {
        const before = container.scrollTop;
        if (container.scrollHeight > container.clientHeight) {
          container.scrollTop += edgeScroll(
            session.y,
            Math.max(0, bounds.top),
            Math.min(window.innerHeight, bounds.bottom),
          );
        }
        if (container.scrollTop === before)
          window.scrollBy(0, edgeScroll(session.y, 0, window.innerHeight));
      }
      updateTarget(session);
      animationFrame.current = requestAnimationFrame(tick);
    },
    [updateTarget],
  );

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && pointerDrag.current) {
        event.preventDefault();
        clearDrag();
      }
    };
    const cancel = () => clearDrag();
    window.addEventListener("keydown", onEscape);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onEscape);
      window.removeEventListener("blur", cancel);
      clearDrag(false);
    };
  }, [clearDrag]);

  useEffect(() => {
    if (disabled) clearDrag();
  }, [disabled, clearDrag]);

  useEffect(() => {
    if (disabled || !keyboardFocus.current) return;
    const previous = keyboardFocus.current;
    keyboardFocus.current = null;
    if (document.activeElement !== document.body && document.activeElement !== previous.button)
      return;
    const fallback = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>("button[data-reorder-id]") ?? [],
    ).find((button) => button.dataset.reorderId === previous.id);
    // An arrow at the new boundary is disabled; the handle still supports the other direction.
    (previous.button.disabled ? fallback : previous.button)?.focus();
  }, [disabled]);

  return (
    <ol className={`prompt-list ${draggingId ? "is-pointer-dragging" : ""}`} ref={list}>
      {prompts.map((prompt, index) => {
        const itemDraft = drafts[prompt.id];
        const isDirty = itemDraft && itemDraft.content !== itemDraft.baseContent;
        const pinned = prompt.id === postHistoryId;
        const previous = prompts[index - 1];
        const next = prompts[index + 1];
        const canMoveUp = !disabled && !pinned && previous !== undefined;
        const canMoveDown = !disabled && !pinned && next !== undefined && next.id !== postHistoryId;

        return (
          <li
            className={[
              "prompt-row",
              selectedId === prompt.id ? "is-selected" : "",
              draggingId === prompt.id ? "is-dragging" : "",
              dropTarget?.id === prompt.id ? `drop-${dropTarget.position}` : "",
            ].join(" ")}
            key={prompt.id}
            data-prompt-id={prompt.id}
          >
            <button
              type="button"
              className="prompt-item"
              onClick={() => onSelect(prompt.id)}
              aria-current={selectedId === prompt.id ? "true" : undefined}
            >
              <span className="prompt-number" aria-hidden="true">
                {(index + 1).toString().padStart(2, "0")}
              </span>
              <span className="prompt-item-copy">
                <span className="prompt-item-title">
                  {prompt.title}
                  {isDirty && (
                    <>
                      <span className="dirty-dot" aria-hidden="true" />
                      <span className="sr-only">Unsaved changes</span>
                    </>
                  )}
                </span>
                <span className="prompt-item-purpose">{prompt.purpose}</span>
                {pinned && (
                  <span className="prompt-item-placement">
                    After Conversation History · Fixed Last
                  </span>
                )}
                <span className="prompt-item-meta">Version {prompt.version}</span>
              </span>
            </button>
            {!pinned && (
              <div className="prompt-reorder-controls">
                <button
                  type="button"
                  className="prompt-drag-handle"
                  disabled={disabled}
                  aria-label={`Reorder ${prompt.title}`}
                  data-reorder-id={prompt.id}
                  aria-describedby="prompt-order-help"
                  title="Drag to reorder, or use the up and down arrow keys"
                  onPointerDown={(event) => {
                    if (disabled || !event.isPrimary || event.button !== 0 || pointerDrag.current)
                      return;
                    event.preventDefault();
                    pointerDrag.current = {
                      pointerId: event.pointerId,
                      id: prompt.id,
                      handle: event.currentTarget,
                      startX: event.clientX,
                      startY: event.clientY,
                      x: event.clientX,
                      y: event.clientY,
                      active: false,
                    };
                    try {
                      event.currentTarget.setPointerCapture(event.pointerId);
                    } catch {
                      // A lost pointer must not leave a session blocking the next drag.
                      clearDrag();
                    }
                  }}
                  onPointerMove={(event) => {
                    const session = pointerDrag.current;
                    if (!session || session.pointerId !== event.pointerId) return;
                    session.x = event.clientX;
                    session.y = event.clientY;
                    if (!session.active) {
                      if (Math.hypot(session.x - session.startX, session.y - session.startY) < 6)
                        return;
                      session.active = true;
                      setDraggingId(session.id);
                      animationFrame.current = requestAnimationFrame(trackDrag);
                    }
                    event.preventDefault();
                    updateTarget(session);
                  }}
                  onPointerUp={(event) => {
                    const session = pointerDrag.current;
                    if (!session || session.pointerId !== event.pointerId) return;
                    session.x = event.clientX;
                    session.y = event.clientY;
                    const moved =
                      session.active ||
                      Math.hypot(session.x - session.startX, session.y - session.startY) >= 6;
                    const target = moved ? findTarget(session) : null;
                    clearDrag();
                    if (!disabled && target) onMove(session.id, target.id, target.position);
                  }}
                  onPointerCancel={(event) => {
                    if (pointerDrag.current?.pointerId === event.pointerId) clearDrag();
                  }}
                  onLostPointerCapture={(event) => {
                    if (
                      pointerDrag.current?.pointerId === event.pointerId &&
                      !event.currentTarget.hasPointerCapture(event.pointerId)
                    )
                      clearDrag();
                  }}
                  onDragStart={(event) => {
                    // Suppress WebKit's native text/image drag; pointer capture owns this gesture.
                    event.preventDefault();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                      event.preventDefault();
                      if (event.key === "ArrowUp" && canMoveUp && previous) {
                        keyboardFocus.current = { id: prompt.id, button: event.currentTarget };
                        onMove(prompt.id, previous.id, "before");
                      }
                      if (event.key === "ArrowDown" && canMoveDown && next) {
                        keyboardFocus.current = { id: prompt.id, button: event.currentTarget };
                        onMove(prompt.id, next.id, "after");
                      }
                    }
                  }}
                >
                  <span aria-hidden="true">⠿</span>
                </button>
                <button
                  type="button"
                  disabled={!canMoveUp}
                  aria-label={`Move ${prompt.title} up`}
                  title={`Move ${prompt.title} up`}
                  onClick={(event) => {
                    if (canMoveUp && previous) {
                      if (event.detail === 0)
                        keyboardFocus.current = { id: prompt.id, button: event.currentTarget };
                      onMove(prompt.id, previous.id, "before");
                    }
                  }}
                >
                  <span aria-hidden="true">↑</span>
                </button>
                <button
                  type="button"
                  disabled={!canMoveDown}
                  aria-label={`Move ${prompt.title} down`}
                  title={`Move ${prompt.title} down`}
                  onClick={(event) => {
                    if (canMoveDown && next) {
                      if (event.detail === 0)
                        keyboardFocus.current = { id: prompt.id, button: event.currentTarget };
                      onMove(prompt.id, next.id, "after");
                    }
                  }}
                >
                  <span aria-hidden="true">↓</span>
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
