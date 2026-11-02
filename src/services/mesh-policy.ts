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
