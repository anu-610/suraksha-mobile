/**
 * @fileoverview Canonical data contract for SOS operations shared across all teams.
 * Defines payload structures, delivery methods, and BLE protocol types for the Suraksha SOS module.
 */

/**
 * Types of emergencies for categorization and prioritization by responders.
 */
export enum SOSType {
  MEDICAL = 'MEDICAL',
  FIRE = 'FIRE',
  FLOOD = 'FLOOD',
  EARTHQUAKE = 'EARTHQUAKE',
  VIOLENCE = 'VIOLENCE',
  STRUCTURAL_COLLAPSE = 'STRUCTURAL_COLLAPSE',
  OTHER = 'OTHER'
}

/**
 * Current status of the SOS distress signal.
 */
export enum SOSStatus {
  ACTIVE = 'ACTIVE',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  RESPONDING = 'RESPONDING',
  RESOLVED = 'RESOLVED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED'
}

/**
 * How the SOS message was delivered to the network.
 */
export enum DeliveryMethod {
  DIRECT_ONLINE = 'DIRECT_ONLINE',
  BLE_RELAY = 'BLE_RELAY',
  OFFLINE_QUEUED = 'OFFLINE_QUEUED'
}

/**
 * The type of the SOS message being transmitted.
 */
export enum SOSMessageType {
  SOS_ALERT = 'SOS_ALERT',
  SOS_CANCEL = 'SOS_CANCEL',
  SOS_ACK = 'SOS_ACK',
  SOS_HELPER = 'SOS_HELPER'
}

/**
 * Represents the geographic location of an SOS event.
 */
export interface SOSLocation {
  /** Sensor capture time, independent of the SOS update time; absent means unknown. */
  capturedAt?: string;
  /** Latitude in decimal degrees */
  latitude: number;
  /** Longitude in decimal degrees */
  longitude: number;
  /** Altitude in meters above sea level */
  altitude?: number;
  /** Estimated horizontal accuracy in meters */
  accuracy: number;
  /** Device heading in degrees */
  heading?: number;
  /** Device speed in meters per second */
  speed?: number;
  /** Provider used for the location fix */
  provider: 'gps' | 'network' | 'fused' | 'last_known';
}

/**
 * Represents a device in the mesh network that relayed the SOS message.
 */
export interface RelayNode {
  /** Unique ID of the relay device */
  deviceId: string;
  /** ISO 8601 UTC timestamp of relay */
  timestamp: string;
  /** Location of the relay node when it relayed the message */
  location?: SOSLocation;
  /** Received Signal Strength Indicator */
  rssi?: number;
}

/**
 * Core SOS Payload. This is the canonical structure transmitted over API and BLE mesh.
 */
export interface OriginProof {
  certificate: string; // Backend CA-signed ES256 device certificate; safe to relay.
  signedPayload: string; // Exact immutable UTF-8 JSON bytes, never reserialize before verification.
  signature: string; // P-256/SHA-256 IEEE-P1363 signature, 64-byte lowercase hex.
}

export interface SOSPayload {
  /** Version 2 signs control type and revision; absent means legacy alert. */
  protocolVersion?: 2 | 3;
  revision?: number;
  helperRequested?: boolean;
  helperRequestId?: string;
  helperRequestExpiresAt?: string;
  helperState?: 'pending' | 'accepted' | 'declined' | 'withdrawn';
  receiptKind?: 'peer' | 'server';
  receiptRevision?: number;
  receiptMessageType?: SOSMessageType.SOS_ALERT | SOSMessageType.SOS_CANCEL;
  receiptStatus?: 'received' | 'accepted' | 'cancelled';
  serverReceipt?: string;
  receiptUserId?: string;
  /** Local queue metadata; never transmitted over BLE or HTTP. */
  uploadOnly?: boolean;
  targetSosId?: string;
  targetDeviceId?: string;
  originProof?: OriginProof;
  /** UUIDv4 generated client-side to ensure idempotency and prevent duplicates */
  sosId: string;
  /** Type of the message (Alert, Cancel, Ack) */
  messageType: SOSMessageType;
  /** User identifier of the person initiating the SOS */
  userId: string;
  /** Full name of the user in distress */
  userName: string;
  /** Contact phone number */
  userPhone: string;
  /** JWT for authorization, optional for offline/relayed messages */
  authToken?: string;
  /** Type of emergency */
  sosType: SOSType;
  /** Location data from device sensors */
  location: SOSLocation | null;
  /** ISO 8601 UTC timestamp of the SOS trigger */
  timestamp: string;
  /** Immutable unique identifier for the hardware/installation originating the SOS */
  originDeviceId: string;
  /** Number of times this message has been relayed (starts at 0) */
  hopCount: number;
  /** Maximum allowed relays (default 15 to prevent infinite loops) */
  maxHops: number;
  /** Audit trail of devices that relayed this message */
  relayChain: RelayNode[];
  /** How this payload was sent to the backend/receivers */
  deliveryMethod: DeliveryMethod;
  /** Current state of the SOS */
  status: SOSStatus;
  /** Optional user-provided context for the distress signal */
  message?: string;
  /** References to async-uploaded media resources */
  mediaAttachmentIds?: string[];
  /** Validity period in seconds (typically 3600) */
  ttlSeconds: number;
  /** Local creation ISO 8601 timestamp */
  createdAt: string;
}

/**
 * Used for cancelling an active SOS.
 */
export interface SOSCancellation {
  /** ID of the SOS to cancel */
  sosId: string;
  /** User initiating the cancellation */
  userId: string;
  /** ISO 8601 cancellation timestamp */
  cancelledAt: string;
  /** Optional reason for cancellation */
  reason?: string;
}

/**
 * BLE Advertising Packet Data format.
 * Designed to fit within BLE advertisement size constraints.
 */
export interface BLEAdvertisementData {
  /** Suraksha Custom 128-bit UUID */
  serviceUUID: string;
  /** First 8 characters of sosId for deduplication during discovery */
  sosIdShort: string;
  /** Type of message being advertised */
  messageType: SOSMessageType;
}

/**
 * Data payload read/written via BLE GATT Characteristics.
 */
export interface BLEGATTPayload {
  /** Full SOS Payload */
  payload: SOSPayload;
  /** CRC32 integrity check to prevent corrupted transmissions */
  checksum: string;
}

/**
 * API Response format for SOS endpoints.
 */
export interface SOSResponse {
  receipt?: string;
  /** Whether the operation was successful */
  success: boolean;
  /** Echo of the processed sosId */
  sosId: string;
  /** Human readable message from server */
  message: string;
  /** True if the server had already processed this SOS previously */
  isDuplicate: boolean;
  /** Server processing ISO 8601 timestamp */
  serverTimestamp: string;
}

/**
 * Extended SOS Payload structure containing active event data (e.g. proximity).
 */
export interface ActiveSOSEvent extends SOSPayload {
  /** Calculated distance from querying user in meters */
  distanceMeters?: number;
  /** List of user/responder IDs who acknowledged */
  acknowledgedBy?: string[];
  /** Count of responders en route */
  respondersEnRoute?: number;
}
