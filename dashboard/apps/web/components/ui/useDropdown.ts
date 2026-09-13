"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * Headless open/close state for a dropdown. The caller owns the DOM ref (so it
 * can be attached directly in JSX); this hook only manages the open flag and
 * wires outside-click + Escape dismissal against that ref.
 */
export function useDismissible<T extends HTMLElement>(ref: RefObject<T | null>) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref]);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  return { open, close, toggle };
}
