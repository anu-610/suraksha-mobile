import { Buffer } from 'buffer';
import { SOSPayload, SOSType, SOSMessageType } from '../interfaces/sos.types';

export function isLivePayload(payload: SOSPayload): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const age = Date.now() - Date.parse(payload.timestamp);
  return typeof payload.sosId === 'string' && payload.sosId.length > 0 &&
    typeof payload.userId === 'string' && typeof payload.userName === 'string' &&
    Object.values(SOSType).includes(payload.sosType) && [SOSMessageType.SOS_ALERT, SOSMessageType.SOS_CANCEL, SOSMessageType.SOS_HELPER].includes(payload.messageType) &&
    (payload.protocolVersion === undefined ? payload.messageType === SOSMessageType.SOS_ALERT :
      payload.protocolVersion === 2 && Number.isSafeInteger(payload.revision) && payload.revision! >= 0) &&
    (payload.messageType !== SOSMessageType.SOS_HELPER || (typeof payload.targetSosId === 'string' && typeof payload.targetDeviceId === 'string' && payload.ttlSeconds <= 300 && !!payload.location)) &&
    Number.isFinite(age) && age >= -300000 && age < payload.ttlSeconds * 1000 &&
    Number.isInteger(payload.ttlSeconds) && payload.ttlSeconds > 0 && payload.ttlSeconds <= 3600 &&
    Number.isInteger(payload.hopCount) && payload.hopCount >= 0 &&
    Number.isInteger(payload.maxHops) && payload.maxHops >= 0 && payload.maxHops <= 15 && payload.hopCount <= payload.maxHops &&
    Array.isArray(payload.relayChain) && payload.relayChain.length <= 15 && payload.relayChain.every(node => node && typeof node.deviceId === 'string' && Number.isFinite(Date.parse(node.timestamp))) &&
    (payload.location === null || (!!payload.location && Number.isFinite(payload.location.latitude) && Math.abs(payload.location.latitude) <= 90 &&
    Number.isFinite(payload.location.longitude) && Math.abs(payload.location.longitude) <= 180));
}

export function encodePayload(payload: SOSPayload): string {
  if (!isLivePayload(payload)) throw new Error('Invalid or expired BLE alert');
  const { authToken: _secret, ...safe } = payload;
  const data = Buffer.from(JSON.stringify(safe), 'utf8');
  if (data.length > 16384) throw new Error('Alert exceeds the 16 KiB mesh limit; retained for online delivery.');
  return data.toString('base64');
}
export function decodePayload(base64: string): SOSPayload {
  const data = Buffer.from(base64, 'base64');
  if (data.length > 16384) throw new Error('Oversized BLE payload');
  const payload = JSON.parse(data.toString('utf8')) as SOSPayload;
  if (!isLivePayload(payload)) throw new Error('Invalid or expired BLE alert');
  delete payload.authToken;
  return payload;
}
