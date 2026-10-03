import { useCallback, useRef, useSyncExternalStore } from "react";
import type { Store } from "./stores.ts";

interface Subscribable {
  subscribe(listener: () => void): () => void;
}

/// Reads one value out of a store. The component re-renders only when the
/// selected value changes (`Object.is`), so select a primitive or a reference
/// the store already holds — never build a new object here; use `useDerived`.
export function useStore<T, S>(store: Store<T>, select: (state: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

/// Structural equality for small plain-data view models (strings, numbers,
/// booleans, null, arrays and plain objects of those).
export function equalData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) =>
    equalData(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
    ),
  );
}

/// A small view model computed from one or more stores. It is recomputed on
/// every store change but the component re-renders only when the result is
/// structurally different — so a top bar fed by a 20 Hz store renders when the
/// text it shows changes, not twenty times a second.
export function useDerived<R>(stores: Subscribable[], compute: () => R): R {
  const cache = useRef<{ value: R } | null>(null);
  // The store list is fixed per call site, so the joined subscription is built
  // once and kept stable for useSyncExternalStore.
  const subscribe = useCallback(subscribeAll(stores), []);
  return useSyncExternalStore(subscribe, () => {
    const next = compute();
    if (cache.current && equalData(cache.current.value, next)) {
      return cache.current.value;
    }
    cache.current = { value: next };
    return next;
  });
}

function subscribeAll(stores: Subscribable[]) {
  return (listener: () => void) => {
    const disposers = stores.map((store) => store.subscribe(listener));
    return () => {
      for (const dispose of disposers) dispose();
    };
  };
}
