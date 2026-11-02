import { SOSPayload, SOSCancellation, SOSResponse, ActiveSOSEvent, SOSLocation, RelayNode } from '../interfaces/sos.types';
import { sessionToken } from './session.service';
import { apiUrl, loadApiSettings } from '../constants/api';

type WireResponse = { success: boolean; sos_id: string; message: string; is_duplicate: boolean; server_timestamp: string; receipt?: string };
const wireLocation = (location: SOSLocation) => ({ ...location, lat: location.latitude, lng: location.longitude, captured_at: location.capturedAt });
export const toWirePayload = (payload: SOSPayload) => ({
  origin_proof: payload.originProof ? { certificate: payload.originProof.certificate,
    signed_payload: payload.originProof.signedPayload, signature: payload.originProof.signature } : undefined,
  protocol_version: payload.protocolVersion, revision: payload.revision ?? 0, helper_requested: payload.helperRequested ?? false,
  helper_request_id: payload.helperRequestId, helper_request_expires_at: payload.helperRequestExpiresAt, helper_state: payload.helperState,
  sos_id: payload.sosId, user_id: payload.userId, user_name: payload.userName,
  user_phone: payload.userPhone, sos_type: payload.sosType, message_type: payload.messageType,
  location: payload.location ? wireLocation(payload.location) : null, delivery_method: payload.deliveryMethod,
  hop_count: payload.hopCount, max_hops: payload.maxHops,
  relay_chain: payload.relayChain.map(node => ({ device_id: node.deviceId, timestamp: node.timestamp,
    location: node.location ? wireLocation(node.location) : undefined, rssi: node.rssi })),
  message: payload.message, media_attachment_ids: payload.mediaAttachmentIds,
  origin_device_id: payload.originDeviceId, ttl_seconds: payload.ttlSeconds, client_timestamp: payload.timestamp,
});

export class ApiError extends Error {
  constructor(message: string, public status: number, public retryAfterMs?: number, public receipt?: string) { super(message); }
}

export class SOSApiService {
  // Session credentials stay in memory, outside BLE payloads and persisted retry queues.
  private static token: string | undefined;
  public static setAuthToken(token?: string) { this.token = token; }

  private static async request<T>(path: string, options: RequestInit, token?: string, renewed = false): Promise<T> {
    await loadApiSettings();
    const url = apiUrl(`/api/v1${path}`);
    // Refresh has its own timeout. Do not spend the SOS HTTP budget waiting for
    // credentials or let an old compatibility token shadow a refreshed account.
    const accountToken = await sessionToken(renewed);
    const accessToken = accountToken || token || this.token;
    { // Durable queues schedule subsequent attempts; a request must not monopolize the relay.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const headers = new Headers(options.headers);
        if (!(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
        if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
        const response = await fetch(url, { ...options, headers, signal: controller.signal });
        if (response.status === 401 && accountToken && !renewed) {
          clearTimeout(timer);
          return this.request<T>(path, options, token, true);
        }
        const text = await response.text();
        let data;
        try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
        if (!response.ok) {
          const detail = typeof data.detail === 'string' ? data.detail : Array.isArray(data.detail) ? data.detail.map((item: { loc?: string[]; msg?: string }) => `${item.loc?.join('.')}: ${item.msg}`).join('; ') : data.detail?.message || data.message || `HTTP ${response.status}`;
          const retry = response.headers.get('Retry-After');
          const retryMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : undefined;
          throw new ApiError(detail, response.status, retryMs !== undefined && Number.isFinite(retryMs) ? Math.max(1000, Math.min(3600000, retryMs)) : undefined, data.detail?.receipt);
        }
        return data as T;
      } catch (error) {
        if (controller.signal.aborted) throw new Error('Backend connection timed out. SOS remains queued for retry.');
        throw error;
      } finally { clearTimeout(timer); }
    }
  }

  private static result(data: WireResponse): SOSResponse {
    if (!data.success) throw new Error(data.message || 'Server rejected the SOS operation');
    return { success: data.success, sosId: data.sos_id, message: data.message,
      isDuplicate: data.is_duplicate, serverTimestamp: data.server_timestamp, receipt: data.receipt };
  }

  public static async sendSOS(payload: SOSPayload): Promise<SOSResponse> {
    return this.result(await this.request<WireResponse>(payload.messageType === 'SOS_CANCEL' ? '/sos/mesh-cancel' : '/sos', {
      method: 'POST', body: JSON.stringify(toWirePayload(payload)),
    }, payload.authToken));
  }

  public static async cancelSOS(cancellation: SOSCancellation, authToken?: string): Promise<SOSResponse> {
    return this.result(await this.request<WireResponse>('/sos/cancel', {
      method: 'POST', body: JSON.stringify({ sos_id: cancellation.sosId, user_id: cancellation.userId, reason: cancellation.reason }),
    }, authToken));
  }

  public static async getActiveSOS(lat: number, lng: number, radiusKm: number, authToken?: string): Promise<ActiveSOSEvent[]> {
    type WireLocation = { lat: number; lng: number; accuracy?: number; provider?: SOSLocation['provider']; captured_at?: string };
    type WireEvent = ReturnType<typeof toWirePayload> & { id: string; status: ActiveSOSEvent['status'];
      created_at: string; distance_meters?: number; acknowledged_by?: string[]; responders_en_route?: number };
    const events = await this.request<WireEvent[]>(`/sos/active?lat=${lat}&lng=${lng}&radius_km=${radiusKm}`, { method: 'GET' }, authToken);
    const location = (value: WireLocation): SOSLocation => ({ ...value, latitude: value.lat, longitude: value.lng,
      accuracy: value.accuracy ?? 0, provider: value.provider ?? 'network', capturedAt: value.captured_at });
    return events.map(event => ({
      sosId: event.sos_id, userId: event.user_id, userName: event.user_name, userPhone: event.user_phone ?? '',
      sosType: event.sos_type, messageType: event.message_type, location: event.location ? location(event.location) : null,
      timestamp: event.client_timestamp, createdAt: event.created_at, originDeviceId: event.origin_device_id ?? '',
      hopCount: event.hop_count, maxHops: event.max_hops ?? 15, ttlSeconds: event.ttl_seconds ?? 3600,
      relayChain: (event.relay_chain ?? []).map((node): RelayNode => ({ deviceId: node.device_id, timestamp: node.timestamp,
        location: node.location ? location(node.location) : undefined, rssi: node.rssi })),
      deliveryMethod: event.delivery_method, status: event.status, message: event.message,
      mediaAttachmentIds: event.media_attachment_ids ?? [], distanceMeters: event.distance_meters,
      acknowledgedBy: event.acknowledged_by ?? [], respondersEnRoute: event.responders_en_route,
    }));
  }

  public static async respond(sosId: string, userId: string): Promise<SOSResponse> {
    const body = new FormData(); body.append('user_id', userId);
    return this.result(await this.request<WireResponse>(`/sos/${encodeURIComponent(sosId)}/respond`, { method: 'POST', body }));
  }

  public static async uploadMedia(sosId: string, fileUri: string, authToken: string, uploadedBy: string): Promise<{ success: boolean; mediaId: string }> {
    const form = new FormData();
    form.append('sos_id', sosId);
    form.append('uploaded_by', uploadedBy);
    form.append('file', { uri: fileUri, name: 'sos.jpg', type: 'image/jpeg' } as unknown as Blob);
    const result = await this.request<{ attachment_id: string }>('/sos/media', { method: 'POST', body: form }, authToken);
    return { success: true, mediaId: result.attachment_id };
  }
}
