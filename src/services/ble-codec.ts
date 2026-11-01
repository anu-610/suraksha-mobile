import { Buffer } from 'buffer';
import { SOSPayload, SOSType, SOSMessageType } from '../interfaces/sos.types';

export function isLivePayload(payload: SOSPayload): boolean {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.messageType === SOSMessageType.SOS_HELPER) {
    if (!payload.targetSosId || !payload.targetDeviceId || payload.ttlSeconds > 300) return false;
    if (payload.protocolVersion === 3) {
      if (!payload.helperRequestId || !Number.isFinite(Date.parse(payload.helperRequestExpiresAt ?? '')) ||
          !['accepted', 'declined', 'withdrawn'].includes(payload.helperState ?? '') ||
          (payload.helperState === 'accepted' ? !payload.location : payload.location !== null)) return false;
    } else if (!payload.location) return false;
  }
  if (payload.messageType === SOSMessageType.SOS_ACK && (payload.protocolVersion !== 3 || !payload.targetSosId || !payload.targetDeviceId ||
      !Number.isSafeInteger(payload.receiptRevision) || payload.receiptRevision! < 0 ||
      !['SOS_ALERT', 'SOS_CANCEL'].includes(payload.receiptMessageType ?? '') || payload.location !== null ||
      !(payload.receiptKind === 'peer' ? payload.receiptStatus === 'received' : payload.receiptKind === 'server' &&
        ['accepted', 'cancelled'].includes(payload.receiptStatus ?? '') && typeof payload.serverReceipt === 'string'))) return false;
  if (payload.protocolVersion === 3 && payload.helperRequested && (!payload.helperRequestId ||
      !Number.isFinite(Date.parse(payload.helperRequestExpiresAt ?? '')) || payload.helperState !== 'pending')) return false;
  const age = Date.now() - Date.parse(payload.timestamp);
  return typeof payload.sosId === 'string' && payload.sosId.length > 0 &&
    typeof payload.userId === 'string' && typeof payload.userName === 'string' &&
    Object.values(SOSType).includes(payload.sosType) && Object.values(SOSMessageType).includes(payload.messageType) &&
    (payload.protocolVersion === undefined ? payload.messageType === SOSMessageType.SOS_ALERT :
      [2, 3].includes(payload.protocolVersion) && Number.isSafeInteger(payload.revision) && payload.revision! >= 0) &&
    Number.isFinite(age) && age >= -300000 && age < payload.ttlSeconds * 1000 &&
    Number.isInteger(payload.ttlSeconds) && payload.ttlSeconds > 0 && payload.ttlSeconds <= 3600 &&
    Number.isInteger(payload.hopCount) && payload.hopCount >= 0 &&
    Number.isInteger(payload.maxHops) && payload.maxHops >= 0 && payload.maxHops <= 15 && payload.hopCount <= payload.maxHops &&
    Array.isArray(payload.relayChain) && payload.relayChain.length <= 15 && payload.relayChain.every(node => node && typeof node.deviceId === 'string' && Number.isFinite(Date.parse(node.timestamp))) &&
    (payload.location === null || (!!payload.location && Number.isFinite(payload.location.latitude) && Math.abs(payload.location.latitude) <= 90 &&
    Number.isFinite(payload.location.longitude) && Math.abs(payload.location.longitude) <= 180 &&
    (payload.location.capturedAt === undefined || (Number.isFinite(Date.parse(payload.location.capturedAt)) && Date.parse(payload.location.capturedAt) <= Date.parse(payload.timestamp) + 300000))));
}

export function encodePayload(payload: SOSPayload): string {
  if (!isLivePayload(payload)) throw new Error('Invalid or expired BLE alert');
  const { authToken: _secret, uploadOnly: _local, ...safe } = payload;
  const data = Buffer.from(JSON.stringify(safe), 'utf8');
  if (data.length > 16384) throw new Error('Alert exceeds the 16 KiB mesh limit; retained for online delivery.');
  return data.toString('base64');
}
export function decodePayload(base64: string): SOSPayload {
  const data = Buffer.from(base64, 'base64');
  if (data.length > 16384) throw new Error('Oversized BLE payload');
  const payload = JSON.parse(data.toString('utf8')) as SOSPayload;
  if (!isLivePayload(payload)) throw new Error('Invalid or expired BLE alert');
  // Legacy signatures do not bind these fields. Never interpret an injected
  // v3 extension as consent, withdrawal, a receipt, or trusted GPS freshness.
  if (payload.protocolVersion !== 3) {
    delete payload.helperRequestId; delete payload.helperRequestExpiresAt; delete payload.helperState;
    delete payload.receiptKind; delete payload.receiptRevision; delete payload.receiptMessageType;
    delete payload.receiptStatus; delete payload.receiptUserId; delete payload.serverReceipt;
    if (payload.location) delete payload.location.capturedAt;
  }
  delete payload.authToken;
  delete payload.uploadOnly;
  return payload;
}
