import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Gap between the rail and the panel's top and bottom edges. */
const RAIL_INSET = 5;
const MIN_THUMB = 26;

interface Props {
  className?: string;
  children: React.ReactNode;
}

/** A panel that scrolls with the app's own rail instead of the browser's scrollbar (see claude-notes/scrollbars.md). */
export function ScrollArea({ className = '', children }: Props) {
  const viewRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startTop: number } | null>(null);

  const [thumb, setThumb] = useState({ height: 0, top: 0, shown: false });
  const [dragging, setDragging] = useState(false);

  const measure = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const { scrollHeight, clientHeight, scrollTop } = view;
    const overflow = scrollHeight - clientHeight;
    const railHeight = clientHeight - RAIL_INSET * 2;
    if (overflow <= 1 || railHeight <= MIN_THUMB) {
      setThumb((t) => (t.shown ? { height: 0, top: 0, shown: false } : t));
      return;
    }
    const height = Math.max(MIN_THUMB, (clientHeight / scrollHeight) * railHeight);
    const top = (scrollTop / overflow) * (railHeight - height);
    setThumb((t) =>
      t.shown && Math.abs(t.height - height) < 0.5 && Math.abs(t.top - top) < 0.5
        ? t
        : { height, top, shown: true },
    );
  }, []);

  // Content grows when a track is added and shrinks when one goes, and the
  // panel itself resizes with the window, so both ends are watched.
  useLayoutEffect(() => {
    measure();
    const view = viewRef.current;
    const content = contentRef.current;
    if (!view || !content) return;
    const ro = new ResizeObserver(measure);
    ro.observe(view);
    ro.observe(content);
    return () => ro.disconnect();
  }, [measure]);

  useEffect(() => {
    measure();
  });

  const scrollTo = (clientY: number, drag: { startY: number; startTop: number }) => {
    const view = viewRef.current;
    if (!view) return;
    const travel = view.clientHeight - RAIL_INSET * 2 - thumb.height;
    const overflow = view.scrollHeight - view.clientHeight;
    if (travel <= 0 || overflow <= 0) return;
    view.scrollTop = drag.startTop + ((clientY - drag.startY) * overflow) / travel;
  };

  const onRailDown = (e: React.PointerEvent) => {
    const view = viewRef.current;
    if (!view) return;
    e.preventDefault();
    const rail = e.currentTarget as HTMLElement;
    rail.setPointerCapture(e.pointerId);

    // Anywhere but the thumb jumps there first, then keeps dragging from it.
    if (e.target !== thumbRef.current) {
      const rect = rail.getBoundingClientRect();
      const travel = rect.height - thumb.height;
      const overflow = view.scrollHeight - view.clientHeight;
      if (travel > 0) {
        const wanted = Math.max(0, Math.min(travel, e.clientY - rect.top - thumb.height / 2));
        view.scrollTop = (wanted / travel) * overflow;
      }
    }
    dragRef.current = { startY: e.clientY, startTop: view.scrollTop };
    setDragging(true);
  };

  const onRailMove = (e: React.PointerEvent) => {
    if (dragRef.current) scrollTo(e.clientY, dragRef.current);
  };

  const onRailUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    setDragging(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  return (
    <div className={`scrollarea ${className}`}>
      <div className="scrollarea-view" ref={viewRef} onScroll={measure}>
        <div className="scrollarea-content" ref={contentRef}>
          {children}
        </div>
      </div>
      <div
        className={`scrollarea-rail ${thumb.shown ? '' : 'idle'} ${dragging ? 'dragging' : ''}`}
        onPointerDown={onRailDown}
        onPointerMove={onRailMove}
        onPointerUp={onRailUp}
        onPointerCancel={onRailUp}
        // The rail sits over the content, so the wheel has to be passed along.
        onWheel={(e) => {
          if (viewRef.current) viewRef.current.scrollTop += e.deltaY;
        }}
      >
        <div
          className="scrollarea-thumb"
          ref={thumbRef}
          style={{ height: `${thumb.height}px`, transform: `translateY(${thumb.top}px)` }}
        />
      </div>
    </div>
  );
}
