import { useCallback, useEffect, useRef, useState } from 'react';
import { AisStreamSource, type AisBoundingBox, type AisSourceStatus } from '@umami/ais';
import type { World } from '@umami/sim';

/**
 * Live AIS from aisstream.io, connected straight from the browser.
 *
 * The API key is the operator's own, entered at runtime and kept in this
 * browser's local storage. It is never committed, never built into the bundle,
 * and never sent anywhere except to aisstream.io itself. That is the only
 * arrangement that works for a publicly deployed build: a key baked into a
 * static site is readable by anyone who opens devtools, and would be a
 * credential handed to every visitor. The same reasoning as charts being
 * opened from local disk rather than bundled.
 *
 * Because the browser holds the key, each operator uses their own account and
 * their own connection quota - aisstream.io allows three concurrent
 * connections per account and three per IP.
 */
const STORAGE_KEY = 'umami.aisstream.key';

/**
 * Endpoint override.
 *
 * Two uses. A relay of your own that holds the credential server-side, which
 * is how a deployment avoids every operator needing their own key. And a local
 * stand-in speaking the same protocol, for testing without touching the live
 * service or burning connection quota.
 */
const STREAM_URL: string | undefined = import.meta.env.VITE_AIS_STREAM_URL;

export interface AisStreamHandle {
  readonly apiKey: string;
  readonly status: AisSourceStatus;
  readonly connected: boolean;
  readonly contactCount: number;
  setApiKey(key: string): void;
  connect(bounds: AisBoundingBox): void;
  disconnect(): void;
  /** Follow the operator's view. Rate limiting is handled by the source. */
  setBounds(bounds: AisBoundingBox): void;
}

function loadKey(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    // Private windows and blocked site data both throw here. A missing key is
    // a normal state, not a failure.
    return '';
  }
}

export function useAisStream(world: World | undefined): AisStreamHandle {
  const [apiKey, setApiKeyState] = useState<string>(loadKey);
  const [status, setStatus] = useState<AisSourceStatus>({ state: 'idle', messageCount: 0 });
  const [contactCount, setContactCount] = useState(0);
  const sourceRef = useRef<AisStreamSource | undefined>(undefined);

  const setApiKey = useCallback((key: string) => {
    setApiKeyState(key);
    try {
      if (key) localStorage.setItem(STORAGE_KEY, key);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Not being able to remember the key is a inconvenience, not a failure;
      // the session still works with what was typed.
    }
  }, []);

  const disconnect = useCallback(() => {
    const source = sourceRef.current;
    if (!source) return;
    void source.stop();
    world?.detachAisSource(source.id);
    sourceRef.current = undefined;
    setStatus({ state: 'stopped', messageCount: 0 });
  }, [world]);

  const connect = useCallback(
    (bounds: AisBoundingBox) => {
      if (!world || !apiKey) return;
      disconnect();

      const source = new AisStreamSource({ apiKey, url: STREAM_URL });
      source.on('status', setStatus);
      sourceRef.current = source;

      // The world routes every message into its track manager, which is what
      // turns a stream of reports into a picture.
      world.attachAisSource(source);
      void source.start({ boundingBoxes: [bounds] });
    },
    [world, apiKey, disconnect],
  );

  const setBounds = useCallback((bounds: AisBoundingBox) => {
    sourceRef.current?.updateSubscription({ boundingBoxes: [bounds] });
  }, []);

  // Report how many vessels are actually being tracked, which is a much better
  // signal that the feed is working than a message counter alone: a busy feed
  // with zero contacts means the bounding box is wrong.
  useEffect(() => {
    if (!world) return;
    const id = setInterval(() => {
      setContactCount(world.tracks.size);
      // Poll the source's own status too. It is emitted only when the
      // connection state changes, so the message counter inside it would
      // otherwise sit at whatever it held when the socket went live - showing
      // "0 messages" against a feed that is plainly working.
      const source = sourceRef.current;
      if (source) setStatus(source.status);
    }, 1000);
    return () => clearInterval(id);
  }, [world]);

  // Never leave a socket open behind a closing page.
  useEffect(() => () => disconnect(), [disconnect]);

  return {
    apiKey,
    status,
    connected: status.state === 'live' || status.state === 'reconnecting',
    contactCount,
    setApiKey,
    connect,
    disconnect,
    setBounds,
  };
}
