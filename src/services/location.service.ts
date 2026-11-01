import * as Location from 'expo-location';
import { SOSLocation } from '../interfaces/sos.types';

export class LocationService {
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
    return { latitude: position.coords.latitude, longitude: position.coords.longitude,
      altitude: position.coords.altitude ?? undefined, accuracy: position.coords.accuracy ?? 1000,
      heading: position.coords.heading ?? undefined, speed: position.coords.speed ?? undefined, provider };
  }
}
