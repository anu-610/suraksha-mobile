import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Animated,
  TouchableOpacity,
  Modal,
  Vibration,
  ScrollView,
  Linking,
  Alert,
} from 'react-native';

// ── Config ──────────────────────────────────────────────────────
import { SOSTriggerService } from '../services/sos-trigger.service';
import { SOSApiService } from '../services/sos-api.service';
import { BackendSettings } from '../components/BackendSettings';
import { AuthPanel } from '../components/AuthPanel';
import { Session, loadSession, signOut } from '../services/session.service';
import { startSOSTracking, stopSOSTracking } from '../services/sos-tracking.service';
import { setRelayEnabled, isRelayEnabled, helperOffers, shareHelperLocation } from '../services/mesh-runtime.service';
import { useBLEMesh } from '../hooks/useBLEMesh';
import { DeliveryMethod, SOSType, SOSPayload } from '../interfaces/sos.types';

const SOS_TYPES = Object.values(SOSType);

const LONG_PRESS_MS = 3000;

function RelayPanel({ deviceId, userId }: { deviceId: string; userId: string }) {
  const { isScanning, nearbySOSEvents, error, dismissSOS } = useBLEMesh(deviceId);
  return <View style={{ padding: 16, gap: 12 }}>
    <Text style={{ color: '#ddd' }}>{isScanning ? 'Nearby relay enabled' : 'Nearby SOS alerts'}</Text>
    {error && <Text style={{ color: '#ff9b90' }}>{error}</Text>}
    {nearbySOSEvents.map(event => <View key={event.sosId} style={{ padding: 12, borderWidth: 1, borderColor: '#f66' }}>
      <Text style={{ color: '#fff' }}>{event.sosType}: {event.userName} needs help.</Text>
      <Text style={{ color: '#ddd' }}>{event.distanceMeters == null ? 'Distance unavailable' : `${Math.round(event.distanceMeters)} m away`} · {event.location ? `${event.location.latitude.toFixed(5)}, ${event.location.longitude.toFixed(5)}` : 'Location unavailable'}</Text>
      {event.location && <TouchableOpacity onPress={() => { if (!event.location) return; void Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${event.location.latitude},${event.location.longitude}`).catch(() => Alert.alert('Unable to open maps')); }}><Text style={{ color: '#7af', padding: 8 }}>View location</Text></TouchableOpacity>}
      <TouchableOpacity onPress={async () => {
        try { await SOSApiService.respond(event.sosId, userId); Alert.alert('Response recorded', 'The server has recorded that you are on your way.'); }
        catch (error) { Alert.alert('Response not confirmed', error instanceof Error ? error.message : 'Reconnect and try again.'); }
      }}><Text style={{ color: '#7af', padding: 8 }}>I can help — mark me en route</Text></TouchableOpacity>
      {event.helperRequested && <TouchableOpacity onPress={() => Alert.alert('Share your location?',
        'This person asks to approach an online helper. Share a GPS snapshot for 5 minutes and allow them to approach? Nearby mesh devices can read this snapshot. Your location is not shared unless you agree.', [
          { text: 'Decline', style: 'cancel' }, { text: 'Agree and share', onPress: () => { void shareHelperLocation(event)
            .then(() => Alert.alert('Location shared', 'Your snapshot is being relayed for 5 minutes. Stay there only if safe.'))
            .catch(error => Alert.alert('Unable to share', error.message)); } }])}>
        <Text style={{ color: '#7af', padding: 8 }}>Request: may this person approach you?</Text>
      </TouchableOpacity>}
      <TouchableOpacity accessibilityRole="button" onPress={() => { void dismissSOS(event.sosId).catch(() => Alert.alert('Unable to dismiss alert', 'Please try again.')); }}><Text style={{ color: '#ddd', padding: 8 }}>Dismiss this message</Text></TouchableOpacity>
    </View>)}
  </View>;
}

// ── Main Screen ─────────────────────────────────────────────────
export default function Index() {
  const [isPressing, setIsPressing] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'queued' | 'error'>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [relayDevice, setRelayDevice] = useState<string | null>(null);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const userId = session?.user.user_id ?? '';
  const userName = session?.user.name ?? '';
  const userPhone = session?.user.phone ?? '';
  useEffect(() => {
    void loadSession().then(setSession);
    void isRelayEnabled().then(enabled => { if (enabled) void SOSTriggerService.getDeviceId().then(setRelayDevice); });
  }, []);
  const [lastSOS, setLastSOS] = useState<SOSPayload | null>(null);
  const [offers, setOffers] = useState<SOSPayload[]>([]);
  useEffect(() => {
    const refresh = async () => {
      if (!userId) { setLastSOS(null); setOffers([]); return; }
      const active = (await SOSTriggerService.activeSOS()).find(p => p.userId === userId) ?? null;
      setLastSOS(active);
      setOffers(active ? await helperOffers(active.sosId) : []);
    };
    void refresh();
    const timer = setInterval(() => { void refresh().catch(() => undefined); }, 5000);
    return () => clearInterval(timer);
  }, [userId]);
  const sending = useRef(false);
  const [pulseAnim] = useState(() => new Animated.Value(1));
  const [progressAnim] = useState(() => new Animated.Value(0));
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (pressTimer.current) clearTimeout(pressTimer.current); }, []);

  // Pulse animation
  useEffect(() => {
    if (status === 'idle' && !isPressing) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.12, duration: 1000, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
  }, [status, isPressing, pulseAnim]);

  // ── Press handlers ────────────────────────────────────────────
  const onPressIn = () => {
    if (sending.current || showPicker) return;
    if (lastSOS) { Alert.alert("SOS already active", "Cancel your current SOS before starting another one."); return; }
    setIsPressing(true);
    Vibration.vibrate(50);
    Animated.timing(progressAnim, { toValue: 1, duration: LONG_PRESS_MS, useNativeDriver: false }).start();

    pressTimer.current = setTimeout(() => {
      setIsPressing(false);
      Vibration.vibrate([0, 300, 150, 300]);
      setShowPicker(true);
    }, LONG_PRESS_MS);
  };

  const onPressOut = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    setIsPressing(false);
    Animated.timing(progressAnim, { toValue: 0, duration: 200, useNativeDriver: false }).start();
  };

  const sendSOS = async (type: SOSType) => {
    if (sending.current) return;
    sending.current = true;
    setShowPicker(false);
    setStatus('sending');
    setStatusMsg('Preparing emergency SOS…');
    try {
      const payload = await SOSTriggerService.triggerSOS({ userId, userName, userPhone,
        sosType: type });
      setLastSOS(payload);
      Alert.alert('Keep SOS location updated', 'Suraksha attempts a location update every minute while SOS is active. Allow background location to continue with the screen locked. Android may open Settings: choose Allow all the time.', [
        { text: 'While app is open', style: 'cancel' },
        { text: 'Enable background updates', onPress: () => { void startSOSTracking().then(enabled => {
          if (!enabled) Alert.alert('Background updates unavailable', 'Keep the app open for location updates.');
        }).catch(error => Alert.alert('Tracking unavailable', error.message)); } },
      ]);
      if (payload.deliveryMethod === DeliveryMethod.DIRECT_ONLINE) {
        setStatus('sent');
        setStatusMsg(`SOS received by server. ID: ${payload.sosId.slice(0, 8)}`);
      } else {
        setStatus('queued');
        setStatusMsg(payload.deliveryMethod === DeliveryMethod.BLE_RELAY
          ? payload.location ? 'SOS saved locally and advertising over Bluetooth. Server receipt is not confirmed.' : 'SOS advertising over Bluetooth without location. Server receipt is not confirmed.'
          : 'SOS saved on this device. Waiting for connectivity; server receipt is not confirmed.');
      }
    } catch (error) {
      setStatus('error');
      setStatusMsg(error instanceof Error ? error.message : 'Unable to send SOS.');
    } finally {
      sending.current = false;
      progressAnim.setValue(0);
    }
  };

  const cancelSOS = async () => {
    if (!lastSOS || sending.current) return;
    sending.current = true;
    try {
      const confirmed = await SOSTriggerService.cancelSOS(lastSOS.sosId, lastSOS.userId, undefined);
      setStatus(confirmed ? 'idle' : 'queued');
      setStatusMsg(confirmed ? 'SOS cancellation confirmed by server.' : 'Cancellation saved. Server confirmation is pending.');
      setLastSOS(null);
      await stopSOSTracking().catch(() => undefined);
    } catch (error) {
      setStatus('error');
      setStatusMsg(error instanceof Error ? error.message : 'Unable to save cancellation.');
    } finally { sending.current = false; }
  };

  // ── Progress bar height ───────────────────────────────────────
  const progressHeight = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  // ── Button label ──────────────────────────────────────────────
  const label = status === 'sending' ? '...' : status === 'sent' ? '✓' : isPressing ? 'HOLD' : 'SOS';

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>🛡️ Suraksha</Text>
      <Text style={styles.subtitle}>Emergency Response Network</Text>
      <BackendSettings onSaved={() => setSettingsVersion(value => value + 1)} />
      {!session ? <AuthPanel key={settingsVersion} onSession={setSession} /> : <View style={{ padding: 16 }}>
        <Text style={styles.statusText}>Signed in as {session.user.name}</Text>
        <TouchableOpacity onPress={async () => { if (lastSOS) { Alert.alert('SOS is active', 'Cancel your SOS before signing out.'); return; } await setRelayEnabled(false); await stopSOSTracking(); await signOut(); SOSApiService.setAuthToken(undefined); setRelayDevice(null); setSession(null); }}><Text style={styles.statusText}>Sign out</Text></TouchableOpacity>
      </View>}
      <TouchableOpacity style={styles.cancelBtn} onPress={async () => {
        try {
          await setRelayEnabled(!relayDevice);
          setRelayDevice(relayDevice ? null : await SOSTriggerService.getDeviceId());
        } catch (error) { setStatusMsg(error instanceof Error ? error.message : 'Unable to enable nearby relay.'); }
      }}><Text style={styles.statusText}>{relayDevice ? 'Stop nearby relay' : 'Enable nearby relay'}</Text></TouchableOpacity>
      {session && <RelayPanel deviceId={relayDevice ?? ''} userId={userId} />}
      {/* ── SOS Button ── */}
      <View style={styles.center}>
        <Animated.View
          style={[styles.outerRing, { transform: [{ scale: pulseAnim }] }]}
          onStartShouldSetResponder={() => true}
          onResponderGrant={onPressIn}
          onResponderRelease={onPressOut}
          onResponderTerminate={onPressOut}
        >
          <View style={styles.innerCircle}>
            <Animated.View style={[styles.fill, { height: progressHeight }]} />
            <Text style={styles.sosText}>{label}</Text>
          </View>
        </Animated.View>

        <Text style={styles.hint}>Long press for 3 seconds to trigger SOS</Text>
      </View>

      {/* ── Status bar ── */}
      {statusMsg !== '' && (
        <View style={[styles.statusBox, status === 'sent' ? styles.green : status === 'error' ? styles.red : styles.yellow]}>
          <Text style={styles.statusText}>{statusMsg}</Text>
          {status !== 'sending' && <TouchableOpacity accessibilityRole="button" onPress={() => { setStatusMsg(''); setStatus('idle'); }}>
            <Text style={{ color: '#7af', textAlign: 'center', padding: 12 }}>Dismiss message</Text>
          </TouchableOpacity>}
        </View>
      )}

      {lastSOS && <View style={{ padding: 16, gap: 8 }}>
        <Text style={styles.statusText}>Location updates are attempted about every minute while this SOS remains active. Last attempt: {new Date(lastSOS.timestamp).toLocaleTimeString()}.</Text>
        <Text style={styles.statusText}>Without internet, moving out of Bluetooth range can interrupt delivery. Stay nearby if safe; move to safety whenever necessary. Bluetooth broadcasting does not confirm delivery.</Text>
        <TouchableOpacity onPress={async () => {
          try { await setRelayEnabled(true); setRelayDevice(await SOSTriggerService.getDeviceId()); await SOSTriggerService.requestHelper(lastSOS.sosId); Alert.alert('Request broadcasting', 'An online helper must agree before their location is shown.'); }
          catch (error) { Alert.alert('Unable to request help', error instanceof Error ? error.message : 'Try again'); }
        }}><Text style={{ color: '#7af', padding: 8 }}>Ask an online helper for permission to approach</Text></TouchableOpacity>
        {offers.map(offer => <View key={offer.sosId}>
          <Text style={styles.statusText}>{offer.userName} agreed that you may approach if safe. Location shared at {new Date(offer.timestamp).toLocaleTimeString()}; expires after 5 minutes. They had backend connectivity when sharing; it may change.</Text>
          <Text style={styles.statusText}>{offer.location?.latitude.toFixed(5)}, {offer.location?.longitude.toFixed(5)} · accuracy ±{Math.round(offer.location?.accuracy ?? 0)} m</Text>
          <TouchableOpacity onPress={() => { if (offer.location) void Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${offer.location.latitude},${offer.location.longitude}`).catch(() => Alert.alert('Unable to open maps')); }}><Text style={{ color: '#7af', padding: 8 }}>View agreed meeting location</Text></TouchableOpacity>
        </View>)}
      </View>}
      {lastSOS && <TouchableOpacity style={styles.cancelBtn} onPress={cancelSOS}><Text style={styles.statusText}>Cancel this SOS</Text></TouchableOpacity>}
      {/* ── Type Picker Modal ── */}
      <Modal visible={showPicker} transparent animationType="slide" onRequestClose={() => setShowPicker(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Select Emergency Type</Text>
            {SOS_TYPES.map((t) => (
              <TouchableOpacity key={t} style={styles.typeBtn} onPress={() => sendSOS(t)}>
                <Text style={styles.typeBtnText}>{t}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowPicker(false)}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ──────────────────────────────────────────────────────
const styles = StyleSheet.create({
  input: { color: "#fff", borderWidth: 1, borderColor: "#444", borderRadius: 8, padding: 8 },
  root: { flex: 1, backgroundColor: '#0D0D0D' },
  title: { fontSize: 30, fontWeight: 'bold', color: '#fff', textAlign: 'center', marginTop: 20 },
  subtitle: { fontSize: 14, color: '#777', textAlign: 'center', marginTop: 4 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  outerRing: {
    width: 220, height: 220, borderRadius: 110,
    backgroundColor: 'rgba(255,59,48,0.15)',
    justifyContent: 'center', alignItems: 'center',
  },
  innerCircle: {
    width: 170, height: 170, borderRadius: 85,
    backgroundColor: '#FF3B30',
    justifyContent: 'center', alignItems: 'center',
    overflow: 'hidden',
    elevation: 12,
    shadowColor: '#FF3B30', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.45, shadowRadius: 16,
  },
  fill: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.25)' },
  sosText: { color: '#fff', fontSize: 52, fontWeight: '900', zIndex: 2 },
  hint: { color: '#555', marginTop: 24, fontSize: 13 },

  statusBox: { marginHorizontal: 20, marginBottom: 30, padding: 16, borderRadius: 12 },
  green: { backgroundColor: 'rgba(76,175,80,0.15)', borderWidth: 1, borderColor: '#4CAF50' },
  red: { backgroundColor: 'rgba(255,59,48,0.15)', borderWidth: 1, borderColor: '#FF3B30' },
  yellow: { backgroundColor: 'rgba(255,215,0,0.15)', borderWidth: 1, borderColor: '#FFD700' },
  statusText: { color: '#eee', textAlign: 'center', fontSize: 14, lineHeight: 22 },

  modalBg: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  modalCard: { backgroundColor: '#1A1A1A', padding: 24, borderTopLeftRadius: 24, borderTopRightRadius: 24 },
  modalTitle: { fontSize: 20, fontWeight: 'bold', color: '#fff', textAlign: 'center', marginBottom: 20 },
  typeBtn: { padding: 16, backgroundColor: '#2A2A2A', borderRadius: 12, marginBottom: 10 },
  typeBtnText: { fontSize: 16, textAlign: 'center', fontWeight: '600', color: '#FF3B30' },
  cancelBtn: { padding: 16, marginTop: 8 },
  cancelBtnText: { fontSize: 16, textAlign: 'center', color: '#777' },
});
