import { SOSLocation } from '../interfaces/sos.types';

/** Preserve capture time: a heartbeat must never make an old fix look fresh. */
export function latestLocation(current: SOSLocation | null, incoming: SOSLocation | null): SOSLocation | null {
  if (!incoming) return current;
  if (!Number.isFinite(incoming.latitude) || Math.abs(incoming.latitude) > 90 ||
      !Number.isFinite(incoming.longitude) || Math.abs(incoming.longitude) > 180 ||
      !Number.isFinite(incoming.accuracy) || incoming.accuracy < 0) return current;
  const nextTime = Date.parse(incoming.capturedAt ?? '');
  const oldTime = Date.parse(current?.capturedAt ?? '');
  if (Number.isFinite(nextTime) && nextTime > Date.now() + 300000) return current;
  if (!current) return incoming;
  if (Number.isFinite(oldTime) && (!Number.isFinite(nextTime) || nextTime < oldTime)) return current;
  if (nextTime === oldTime && incoming.accuracy > current.accuracy) return current;
  return incoming;
}
