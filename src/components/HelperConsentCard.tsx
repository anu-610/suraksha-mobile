import React, { useEffect, useState } from 'react';
import { Alert, Text, TouchableOpacity, View } from 'react-native';
import { SOSPayload } from '../interfaces/sos.types';
import { helperChoices, respondToHelper, HelperChoice } from '../services/helper-consent.service';
import { requestId, requestIsOpen } from '../services/mesh-policy';

export function HelperConsentCard({ event, userId }: { event: SOSPayload; userId: string }) {
  const [choice, setChoice] = useState<HelperChoice>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = requestId(event);
  useEffect(() => {
    let mounted = true;
    void helperChoices(userId).then(rows => { if (mounted) setChoice(rows.find(p => p.sosId === event.sosId && p.requestId === id)); });
    return () => { mounted = false; };
  }, [id, event.sosId, userId]);
  const choose = async (action: 'accepted' | 'declined' | 'withdrawn') => {
    setBusy(true); setError('');
    try { await respondToHelper(event, action); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to save your choice'); }
    finally {
      setChoice((await helperChoices(userId)).find(p => p.sosId === event.sosId && p.requestId === id));
      setBusy(false);
    }
  };
  if (!event.helperRequested && !choice) return null;
  const open = requestIsOpen(event);
  const state = !open ? event.helperState === 'withdrawn' ? 'withdrawn by sender' : 'expired' : choice?.state;
  return <View style={{ gap: 6 }}>
    <Text style={{ color: '#ddd' }}>Permission to approach: {state ?? 'awaiting your decision'}.</Text>
    {busy && <Text style={{ color: '#ddd' }}>Preparing your reply. Sharing needs backend confirmation and a fresh GPS fix; this may take a few seconds.</Text>}
    {!!error && <Text style={{ color: '#ff9b90' }}>{error}</Text>}
    {open && !busy && !['accepted', 'withdrawn'].includes(choice?.state ?? '') && <View>
      <TouchableOpacity onPress={() => Alert.alert('Share your location?',
        'Share one GPS snapshot for up to 5 minutes and allow this person to approach if safe? Nearby mesh devices can read the snapshot. You can withdraw permission; withdrawal needs time to reach other phones.', [
          { text: 'Not now', style: 'cancel' },
          { text: 'Agree and share', onPress: () => { void choose('accepted'); } },
        ])}><Text style={{ color: '#7af', padding: 8 }}>Agree and share a location snapshot</Text></TouchableOpacity>
      <TouchableOpacity onPress={() => { void choose('declined'); }}><Text style={{ color: '#7af', padding: 8 }}>Decline and send reply</Text></TouchableOpacity>
    </View>}
    {open && (busy || choice?.state === 'accepted' || choice?.state === 'preparing') &&
      <TouchableOpacity onPress={() => { void choose('withdrawn'); }}><Text style={{ color: '#7af', padding: 8 }}>Withdraw permission</Text></TouchableOpacity>}
    {choice?.packet && <Text style={{ color: '#ddd' }}>Your reply is saved for Bluetooth delivery. Arrival at the sender is not confirmed.</Text>}
  </View>;
}
