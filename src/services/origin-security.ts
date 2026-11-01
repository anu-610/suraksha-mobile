import { timedFetch } from './timed-fetch';
import { p256 } from '@noble/curves/nist.js';
import { Buffer } from 'buffer';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { SOSPayload, OriginProof } from '../interfaces/sos.types';
import { apiUrl } from '../constants/api';
import { sessionToken } from './session.service';

const KEY = 'suraksha.device.v2';
const CA = 'suraksha.device.ca.v2';
const options = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
let memory: string | null = null;
let authority: string | null = null;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));
// React Native bundles buffer@6, whose encodings omit Node's 'base64url'.
// JWT segments use the URL-safe alphabet without padding; normalize explicitly.
const decode = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('Invalid device certificate encoding');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(Buffer.from(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='), 'base64'));
};
type Identity = { deviceId: string; userId: string; secret: string; certificate: string };

async function stored(): Promise<Identity | null> {
  const raw = Platform.OS === 'web' ? memory : await SecureStore.getItemAsync(KEY, options);
  return raw ? JSON.parse(raw) : null;
}
export async function enrollDevice(deviceId: string, userId: string): Promise<void> {
  let identity = await stored();
  let secret: Uint8Array;
  if (identity?.userId === userId && identity.deviceId === deviceId) secret = bytes(identity.secret);
  else { do { secret = Crypto.getRandomBytes(32); } while (!p256.utils.isValidSecretKey(secret)); }
  const token = await sessionToken();
  if (!token) throw new Error('Sign in online once before enabling offline SOS.');
  const response = await timedFetch(apiUrl('/api/v1/devices/enroll'), { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId, public_key: hex(p256.getPublicKey(secret, false)) }) });
  if (!response.ok) throw new Error('Device enrollment failed. Configure the backend device certificate authority.');
  const enrolled = await response.json();
  const pinned = process.env.EXPO_PUBLIC_DEVICE_CA_PUBLIC_KEY;
  if (pinned && pinned !== enrolled.ca_public_key) throw new Error('Device certificate authority does not match the configured pin.');
  authority = enrolled.ca_public_key;
  identity = { deviceId, userId, secret: hex(secret), certificate: enrolled.certificate };
  memory = JSON.stringify(identity);
  if (Platform.OS !== 'web') {
    await SecureStore.setItemAsync(KEY, memory, options);
    await SecureStore.setItemAsync(CA, authority!, options);
  }
}
export function immutableOrigin(payload: SOSPayload) {
  return { ...(payload.protocolVersion === 2 ? { protocol_version: 2, message_type: payload.messageType,
      revision: payload.revision, helper_requested: payload.helperRequested ?? false,
      target_sos_id: payload.targetSosId ?? '', target_device_id: payload.targetDeviceId ?? '' } : {}), sos_id: payload.sosId, user_id: payload.userId, user_name: payload.userName,
    user_phone: payload.userPhone || '', sos_type: payload.sosType,
    lat: payload.location?.latitude ?? null, lng: payload.location?.longitude ?? null, timestamp: payload.timestamp,
    origin_device_id: payload.originDeviceId, ttl_seconds: payload.ttlSeconds, max_hops: payload.maxHops, message: payload.message || '' };
}
export async function signOrigin(payload: SOSPayload, allowRenewal = true): Promise<OriginProof> {
  let identity = await stored();
  if (!identity || identity.userId !== payload.userId || identity.deviceId !== payload.originDeviceId) throw new Error('Enroll this device online before sending offline SOS.');
  const claims = JSON.parse(Buffer.from(decode(identity.certificate.split('.')[1])).toString('utf8'));
  if (allowRenewal && claims.exp * 1000 < Date.now() + 86400000) {
    try { await enrollDevice(identity.deviceId, identity.userId); identity = (await stored())!; }
    catch { /* A still-valid certificate can continue working offline. */ }
  }
  const signedPayload = JSON.stringify(immutableOrigin(payload));
  const proof = { certificate: identity.certificate, signedPayload,
    signature: hex(p256.sign(Buffer.from(signedPayload, 'utf8'), bytes(identity.secret), { prehash: true, lowS: true })) };
  await verifyOrigin({ ...payload, originProof: proof });
  return proof;
}
export async function verifyOrigin(payload: SOSPayload): Promise<void> {
  const proof = payload.originProof;
  if (!proof) throw new Error('Unsigned BLE alert');
  authority = process.env.EXPO_PUBLIC_DEVICE_CA_PUBLIC_KEY || authority || (Platform.OS === 'web' ? null : await SecureStore.getItemAsync(CA, options));
  if (!authority) throw new Error('No trusted certificate authority. Connect and sign in first.');
  const parts = proof.certificate.split('.');
  if (parts.length !== 3) throw new Error('Invalid device certificate');
  const header = JSON.parse(Buffer.from(decode(parts[0])).toString('utf8'));
  const claims = JSON.parse(Buffer.from(decode(parts[1])).toString('utf8'));
  if (header.alg !== 'ES256' || claims.iss !== 'suraksha-device-ca' || claims.aud !== 'suraksha-ble' ||
      !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now() || claims.sub !== payload.userId || claims.device_id !== payload.originDeviceId ||
      !p256.verify(decode(parts[2]), Buffer.from(`${parts[0]}.${parts[1]}`), bytes(authority), { prehash: true, lowS: false })) throw new Error('Untrusted or expired device certificate');
  const signed = JSON.parse(proof.signedPayload);
  if (signed.protocol_version !== payload.protocolVersion ||
      (payload.protocolVersion === undefined && (payload.messageType !== 'SOS_ALERT' || (payload.revision ?? 0) !== 0)))
    throw new Error('SOS protocol mismatch');
  const expected = immutableOrigin(payload);
  if (Object.entries(expected).some(([key,value]) => signed[key] !== value) ||
      !p256.verify(bytes(proof.signature), Buffer.from(proof.signedPayload), bytes(claims.public_key), { prehash: true, lowS: false })) throw new Error('SOS origin signature mismatch');
}
