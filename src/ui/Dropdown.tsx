import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDropdown } from './EffectsMenu';
import { ScrollArea } from './ScrollArea';

export interface DropdownOption {
  value: string;
  label: string;
  group?: string;
}

const COMPACT_MQ = '(max-width: 760px), (max-height: 520px)';

/** Select replacement styled like the rest of the chrome: a pill trigger and a glass option list, dropped under the trigger on desktop and presented as a sheet on phones. */
export function Dropdown({
  value, options, onChange, className = '', title, ariaLabel, disabled,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  className?: string;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const { open, setOpen, ref } = useDropdown();
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openedAtRef = useRef(0);
  const [place, setPlace] = useState<React.CSSProperties | undefined>();

  const selected = options.find((o) => o.value === value);

  // Scrolls only the list's own view. scrollIntoView would also reveal
  // through outer panels, and the outside-scroll close reacts to those.
  const revealInList = (el: HTMLElement) => {
    const view = menuRef.current?.querySelector<HTMLElement>('.scrollarea-view');
    if (!view) return;
    const vr = view.getBoundingClientRect();
    const tr = el.getBoundingClientRect();
    if (tr.top < vr.top) view.scrollTop += tr.top - vr.top;
    else if (tr.bottom > vr.bottom) view.scrollTop += tr.bottom - vr.bottom;
  };

  // Fixed positioning escapes the scroll panels' overflow clipping, flipping
  // above the trigger when there is no room below. Phones skip this: the
  // stylesheet lays the list out as a sheet or in place there.
  useLayoutEffect(() => {
    if (!open || window.matchMedia(COMPACT_MQ).matches) {
      setPlace(undefined);
      return;
    }
    const btn = btnRef.current;
    const menu = menuRef.current;
    if (!btn || !menu) return;
    const r = btn.getBoundingClientRect();
    const w = Math.max(menu.offsetWidth, r.width);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const h = menu.offsetHeight;
    const below = r.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below;
    setPlace({ position: 'fixed', left, top, minWidth: r.width });
  }, [open]);

  // The fixed list does not follow its trigger, so any outside scroll closes
  // it. Scrolls right at open are the browser revealing the focused list (the
  // trigger's card may sit half-clipped in its panel), not the user leaving.
  useEffect(() => {
    if (!open) return;
    openedAtRef.current = performance.now();
    const onScroll = (e: Event) => {
      if (performance.now() - openedAtRef.current < 250) return;
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, setOpen]);

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const target =
      menu?.querySelector<HTMLButtonElement>('.menu-item.selected') ??
      menu?.querySelector<HTMLButtonElement>('.menu-item');
    if (target) {
      target.focus({ preventScroll: true });
      revealInList(target);
    }
    return () => btnRef.current?.focus({ preventScroll: true });
  }, [open]);

  const choose = (v: string) => {
    setOpen(false);
    if (v !== value) onChange(v);
  };

  // Arrows stop here so the app-wide shortcuts don't also nudge notes.
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('.menu-item') ?? []);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home' ? 0
        : e.key === 'End' ? items.length - 1
          : e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1)
            : Math.max(0, i - 1);
    items[next].focus({ preventScroll: true });
    revealInList(items[next]);
  };

  const rows: React.ReactNode[] = [];
  let lastGroup: string | undefined;
  for (const o of options) {
    if (o.group && o.group !== lastGroup) {
      rows.push(
        <div key={`group-${o.group}`} className="menu-label">
          {o.group}
        </div>,
      );
    }
    lastGroup = o.group;
    const sel = o.value === value;
    rows.push(
      <button
        key={o.value}
        type="button"
        role="option"
        aria-selected={sel}
        className={sel ? 'menu-item selected' : 'menu-item'}
        onClick={() => choose(o.value)}
      >
        <span className="dd-optlabel">{o.label}</span>
        {sel && (
          <svg className="dd-check" width="10" height="8" viewBox="0 0 10 8" aria-hidden="true">
            <path d="M1 4.2 L3.8 7 L9 1.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>,
    );
  }

  return (
    <div className={`menuwrap dd ${className}`} ref={ref}>
      <button
        ref={btnRef}
        type="button"
        className="dd-btn"
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }
        }}
      >
        <span className="dd-value">{selected?.label ?? '—'}</span>
        <svg className="dd-chevron" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="menu dd-menu" role="listbox" ref={menuRef} style={place} onKeyDown={onMenuKey}>
          <ScrollArea className="dd-scroll">{rows}</ScrollArea>
        </div>
      )}
    </div>
  );
}
