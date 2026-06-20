

import * as RedisLib from "ioredis";
const Redis = (RedisLib as any).default ?? RedisLib;
import type { DocumentRoom } from './room.js';



export interface RelayMessage {
  /** The server instance that published this message. */
  originInstanceId: string;
  /** The raw JSON-serialised CRDT operation or cursor message. */
  payload: string;
}

// ---------------------------------------------------------------------------
// Relay singleton
// ---------------------------------------------------------------------------

const INSTANCE_ID = process.env.INSTANCE_ID ?? `inst-${Math.random().toString(36).slice(2, 8)}`;

let publisher: any | null = null;
let subscriber: any | null = null;

/** True when Redis relay is active. */
export let relayEnabled = false;

/** All active document rooms — registered so the subscriber can broadcast. */
const roomRegistry = new Map<string, DocumentRoom>();

export function registerRoom(docId: string, room: DocumentRoom): void {
  roomRegistry.set(docId, room);
}

export function unregisterRoom(docId: string): void {
  roomRegistry.delete(docId);
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

export async function initRelay(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log('[relay] REDIS_URL not set — running in single-node mode (no relay).');
    return;
  }

  try {
    publisher = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
    subscriber = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });

    await publisher.connect();
    await subscriber.connect();

    // Route incoming messages to the correct room.
    subscriber.on('message', (channel: string, raw: string) => {
      try {
        const msg: RelayMessage = JSON.parse(raw);
        // Ignore messages we published ourselves.
        if (msg.originInstanceId === INSTANCE_ID) return;

        // channel format: doc:<docId>
        const docId = channel.slice(4);
        const room = roomRegistry.get(docId);
        if (!room) return;

        room.applyFromRelay(msg.payload);
      } catch {
        // Malformed message — ignore.
      }
    });

    relayEnabled = true;
    console.log(`[relay] Connected to Redis at ${url} — instance id: ${INSTANCE_ID}`);
  } catch (err) {
    console.warn('[relay] Failed to connect to Redis — falling back to single-node mode.', err);
    relayEnabled = false;
  }
}


export async function publishOp(docId: string, payload: string): Promise<void> {
  if (!publisher || !relayEnabled) return;
  const msg: RelayMessage = { originInstanceId: INSTANCE_ID, payload };
  await publisher.publish(`doc:${docId}`, JSON.stringify(msg));
}


export async function subscribeToDoc(docId: string): Promise<void> {
  if (!subscriber || !relayEnabled) return;
  await subscriber.subscribe(`doc:${docId}`);
}

export async function unsubscribeFromDoc(docId: string): Promise<void> {
  if (!subscriber || !relayEnabled) return;
  await subscriber.unsubscribe(`doc:${docId}`);
}


export async function closeRelay(): Promise<void> {
  await publisher?.quit();
  await subscriber?.quit();
}
