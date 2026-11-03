import { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import * as Peripheral from '../../modules/ble-peripheral';
import { inboxIssue } from '../services/mesh-runtime.service';

const ago = (at: number, now: number) => {
  const s = Math.round((now - at) / 1000);
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : 'over an hour ago';
};

/** Live Bluetooth card, so a failed nearby delivery shows which step failed. */
export function NearbyStatus() {
  const [radio, setRadio] = useState<Peripheral.NearbyRadioStatus | null>(null);
  const [rejected, setRejected] = useState<ReturnType<typeof inboxIssue>>(undefined);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let mounted = true;
    const load = () => { void Peripheral.getStatus().then(value => {
      if (mounted) { setRadio(value); setRejected(inboxIssue()); setNow(Date.now()); }
    }).catch(() => undefined); };
    load();
    const timer = setInterval(load, 2000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);
  if (!radio) return null;
  const lines = [
    radio.advertising ? `Bluetooth broadcast: ON, sharing ${radio.queued} message${radio.queued === 1 ? '' : 's'}.`
      : radio.queued ? 'Bluetooth broadcast: waiting to start.' : 'Bluetooth broadcast: off (nothing to send).',
    radio.served ? `Last read by a nearby phone: ${ago(radio.lastServedAt, now)} (${radio.served} reads).`
      : radio.advertising ? 'No nearby phone has read it yet.' : '',
    `Listening for nearby SOS: ${radio.scanning ? 'ON' : 'off'}${radio.backgroundRelay ? ' (also in background)' : radio.scanning ? ' (while app is open)' : ''}.`,
    radio.scanning ? `Suraksha phones in range: ${radio.nearbyPhones}${radio.lastSeenAt ? `, last seen ${ago(radio.lastSeenAt, now)}` : ''}.` : '',
    radio.received ? `Messages received: ${radio.received}, last ${ago(radio.lastReceivedAt, now)}.` : '',
    radio.failedReads ? `Failed Bluetooth reads: ${radio.failedReads} (normal while phones move in/out of range).` : '',
    radio.lastError && now - radio.lastErrorAt < 300000 ? `Bluetooth problem: ${radio.lastError}` : '',
    rejected && now - rejected.at < 300000 ? `Last nearby message rejected: ${rejected.reason}` : '',
  ].filter(Boolean);
  return <View style={{ marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: '#335', backgroundColor: 'rgba(90,120,255,0.08)' }}>
    {lines.map(line => <Text key={line} style={{ color: '#ccd', fontSize: 13, lineHeight: 20 }}>{line}</Text>)}
  </View>;
}
