"use client";

import { useEffect, useRef } from "react";

interface FilterMenuProps {
  values: string[];
  counts: Record<string, number>;
  active: Set<string>;
  onChange: (next: Set<string>) => void;
  onClose: () => void;
  /** css var prefix to swatch each row, e.g. "--l-" → var(--l-platforms); null for no swatch */
  colorPrefix: string | null;
}

export function FilterMenu({ values, counts, active, onChange, onClose, colorPrefix }: FilterMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current && !ref.current.contains(target) && !(target as HTMLElement).closest(".filter-btn")) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const toggle = (v: string, on: boolean) => {
    const next = new Set(active);
    if (on) next.add(v);
    else next.delete(v);
    onChange(next);
  };

  return (
    <div className="filter-menu" role="menu" ref={ref}>
      {values.map((v) => (
        <label className="filter-opt" key={v}>
          <input type="checkbox" checked={active.has(v)} onChange={(e) => toggle(v, e.target.checked)} />
          {colorPrefix ? (
            <span className="opt-swatch" style={{ background: `var(${colorPrefix}${v})` }} />
          ) : null}
          <span className="opt-label">{v}</span>
          <span className="opt-n">{counts[v] ?? 0}</span>
        </label>
      ))}
    </div>
  );
}
