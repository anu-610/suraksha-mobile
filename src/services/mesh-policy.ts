import { SOSPayload, SOSMessageType } from '../interfaces/sos.types';

export const packetKey = (p: SOSPayload) => `${p.sosId}:${p.messageType}:${p.revision ?? 0}`;
export const expiresAt = (p: SOSPayload) => Date.parse(p.timestamp) + p.ttlSeconds * 1000;
export const requestId = (p: SOSPayload) => p.helperRequestId ?? `legacy-${p.sosId}`;
export const requestExpiry = (p: SOSPayload) => p.helperRequestExpiresAt ? Date.parse(p.helperRequestExpiresAt) : Math.min(expiresAt(p), Date.parse(p.timestamp) + 300000);
export const requestIsOpen = (p: SOSPayload) => p.messageType === SOSMessageType.SOS_ALERT && !!p.helperRequested && p.helperState !== 'withdrawn' && requestExpiry(p) > Date.now();
export function packetPriority(p: SOSPayload): number {
  if (p.messageType === SOSMessageType.SOS_CANCEL) return 0;
  if (p.helperState === 'withdrawn') return 1;
  if (p.messageType === SOSMessageType.SOS_ACK) return 2;
  if (p.messageType === SOSMessageType.SOS_HELPER || p.helperRequested) return 3;
  return 4;
}
export function canReplace(current: SOSPayload | undefined, next: SOSPayload): boolean {
  if (!current) return true;
  if (current.userId !== next.userId) return false;
  if (current.messageType === SOSMessageType.SOS_CANCEL && next.messageType !== SOSMessageType.SOS_CANCEL) return false;
  if (next.messageType === SOSMessageType.SOS_CANCEL && current.messageType !== SOSMessageType.SOS_CANCEL) return true;
  if (current.helperState === 'withdrawn' && next.messageType === SOSMessageType.SOS_HELPER && next.helperState !== 'withdrawn') return false;
  return (next.revision ?? 0) > (current.revision ?? 0) ||
    ((next.revision ?? 0) === (current.revision ?? 0) &&
      (Date.parse(next.timestamp) > Date.parse(current.timestamp) ||
       Date.parse(next.timestamp) === Date.parse(current.timestamp) && next.hopCount <= current.hopCount));
}

// Cancels and receipts only confirm something that already happened. On air for
// 15 min, not the whole 1 h TTL, so old SOS/cancel rounds don't pile up ahead of
// a new SOS. Same rules as the native PacketPolicy.
export const DONE_ON_AIR_MS = 15 * 60000;
const isDone = (p: SOSPayload) => p.messageType === SOSMessageType.SOS_CANCEL || p.messageType === SOSMessageType.SOS_ACK;
export const onAirUntil = (p: SOSPayload) => isDone(p) ? Math.min(expiresAt(p), Date.parse(p.timestamp) + DONE_ON_AIR_MS) : expiresAt(p);
// One receipt per (SOS, kind, sender) is enough: the newest one.
const sameReceiptSlot = (a: SOSPayload, b: SOSPayload) => a.messageType === SOSMessageType.SOS_ACK && b.messageType === SOSMessageType.SOS_ACK &&
  a.targetSosId === b.targetSosId && a.receiptKind === b.receiptKind && a.originDeviceId === b.originDeviceId;
function receiptCompare(a: SOSPayload, b: SOSPayload): number {
  const rank = (p: SOSPayload) => [p.receiptMessageType === SOSMessageType.SOS_CANCEL ? 1 : 0, p.receiptRevision ?? 0, Date.parse(p.timestamp)];
  const [x, y] = [rank(a), rank(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
/** Queued packets that `added` makes useless: older receipts of the same slot, alert receipts of a cancelled SOS. */
export const staleAfter = (added: SOSPayload, queued: SOSPayload[]) => queued.filter(p => p.sosId !== added.sosId && (
  sameReceiptSlot(added, p) && receiptCompare(added, p) >= 0 ||
  added.messageType === SOSMessageType.SOS_CANCEL && p.messageType === SOSMessageType.SOS_ACK && p.targetSosId === added.sosId &&
    p.receiptMessageType === SOSMessageType.SOS_ALERT));
/** `added` is already useless: a newer receipt of its slot, or the cancel of its SOS, is queued. */
export const isStale = (added: SOSPayload, queued: SOSPayload[]) => added.messageType === SOSMessageType.SOS_ACK && queued.some(p => p.sosId !== added.sosId && (
  sameReceiptSlot(added, p) && receiptCompare(p, added) > 0 ||
  added.receiptMessageType === SOSMessageType.SOS_ALERT && p.messageType === SOSMessageType.SOS_CANCEL && p.sosId === added.targetSosId));
