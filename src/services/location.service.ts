import * as Location from 'expo-location';
import { SOSLocation } from '../interfaces/sos.types';

export class LocationService {
  private static cached: SOSLocation | null = null;
  public static availableLocation(): SOSLocation | null {
    return this.cached?.capturedAt && Date.now() - Date.parse(this.cached.capturedAt) < 600000 ? this.cached : null;
  }
  public static async getCurrentLocation(requestPermission = true): Promise<SOSLocation> {
    const permission = await (requestPermission ? Location.requestForegroundPermissionsAsync() : Location.getForegroundPermissionsAsync());
    if (!permission.granted) throw new Error('Location permission is required to send accurate SOS coordinates.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let position: Location.LocationObject;
    let provider: SOSLocation['provider'] = 'gps';
    try {
      position = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Location timed out')), 15000); }),
      ]);
    } catch {
      const cached = await Location.getLastKnownPositionAsync({ maxAge: 600000, requiredAccuracy: 1000 });
      if (!cached) throw new Error('Unable to obtain your location. Move to an open area and try again.');
      position = cached;
      provider = 'last_known';
    } finally { if (timer) clearTimeout(timer); }
    this.cached = { latitude: position.coords.latitude, longitude: position.coords.longitude, capturedAt: new Date(position.timestamp).toISOString(),
      altitude: position.coords.altitude ?? undefined, accuracy: position.coords.accuracy ?? 1000,
      heading: position.coords.heading ?? undefined, speed: position.coords.speed ?? undefined, provider };
    return this.cached;
  }
}

export function locationDescription(location: SOSLocation | null): string {
  if (!location) return 'Location unavailable';
  const age = location.capturedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(location.capturedAt)) / 1000)) : null;
  const freshness = age === null ? 'capture time unknown' : age < 60 ? `${age}s ago` : `${Math.floor(age / 60)} min ago`;
  return `${age === null || age > 120 || location.provider === 'last_known' ? 'Last known location' : 'GPS location'} · ${freshness} · accuracy ±${Math.round(location.accuracy)} m`;
}
