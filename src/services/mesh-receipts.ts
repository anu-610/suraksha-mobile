import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SOSPayload, SOSMessageType, SOSStatus, DeliveryMethod } from '../interfaces/sos.types';
import { signOrigin, readServerReceipt } from './origin-security';
import { isLivePayload } from './ble-codec';
import { packetKey, expiresAt } from './mesh-policy';
import { KEYS, serial, list, enqueue } from './mesh-store';
import { SOSTriggerService, bleMeshInstance } from './sos-trigger.service';

export async function queueServerReceipt(token: string): Promise<SOSPayload> {
  const packet = await readServerReceipt(token);
  if (!isLivePayload(packet)) throw new Error('Invalid server receipt packet');
  await serial(() => enqueue(packet));
  await SOSTriggerService.acceptReceipt(packet);
  void bleMeshInstance.startAdvertising(packet).catch(() => undefined);
  return packet;
}
/** One first-hop receipt per alert revision; receipts never acknowledge receipts. */
export async function queuePeerReceipt(source: SOSPayload, deviceId: string, userId: string, name: string) {
  if (source.hopCount !== 0 || ![SOSMessageType.SOS_ALERT, SOSMessageType.SOS_CANCEL].includes(source.messageType)) return;
  let packet: SOSPayload | undefined;
  await serial(async () => {
    const seen = (await list<{ id: string; until: number }>(KEYS.peerReceipts)).filter(p => p.until > Date.now());
    if (seen.some(p => p.id === packetKey(source))) return;
    const timestamp = new Date().toISOString();
    packet = { protocolVersion: 3, revision: 0, sosId: Crypto.randomUUID(), messageType: SOSMessageType.SOS_ACK,
      userId, userName: name, userPhone: '', sosType: source.sosType, location: null, timestamp, createdAt: timestamp,
      originDeviceId: deviceId, hopCount: 0, maxHops: 15, relayChain: [], ttlSeconds: 3600,
      deliveryMethod: DeliveryMethod.BLE_RELAY, status: SOSStatus.ACTIVE, targetSosId: source.sosId,
      targetDeviceId: source.originDeviceId, receiptKind: 'peer', receiptRevision: source.revision ?? 0,
      receiptMessageType: source.messageType as SOSMessageType.SOS_ALERT | SOSMessageType.SOS_CANCEL,
      receiptStatus: 'received', receiptUserId: source.userId };
    packet.originProof = await signOrigin(packet, false);
    await enqueue(packet);
    await AsyncStorage.setItem(KEYS.peerReceipts, JSON.stringify([...seen, { id: packetKey(source), until: expiresAt(source) + 300000 }]));
  });
  if (packet) void bleMeshInstance.startAdvertising(packet).catch(() => undefined);
}
