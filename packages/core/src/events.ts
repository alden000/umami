/**
 * Minimal typed publish/subscribe.
 *
 * The simulation core never imports a UI framework; it emits events and lets
 * renderers, recorders and the external control bridge subscribe. This is the
 * seam that allows a 3D viewer to be attached later without the core knowing
 * it exists.
 */
export type Unsubscribe = () => void;

export class EventBus<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): Unsubscribe {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => {
      set.delete(handler as (payload: never) => void);
    };
  }

  once<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    // Copy so a handler that unsubscribes during dispatch cannot skip a sibling.
    for (const handler of [...set]) {
      (handler as (p: Events[K]) => void)(payload);
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
