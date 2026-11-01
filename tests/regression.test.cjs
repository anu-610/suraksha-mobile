const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Run the real TypeScript services with only device/network boundaries mocked.
function loader(mocks = {}, globals = {}) {
  // Resolve the same npm Buffer polyfill Metro uses, not Node's richer builtin.
  mocks = { 'expo-crypto': { randomUUID: require('node:crypto').randomUUID }, '@react-native-async-storage/async-storage': {getItem:async()=>null,setItem:async()=>{}}, buffer: require('buffer/'), './session.service': { sessionToken: async () => undefined }, ...mocks };
  const cache = new Map();
  function load(file) {
    file = path.resolve(__dirname, '..', file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const localRequire = name => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
      return require(name);
    };
    vm.runInNewContext(code, { module, exports: module.exports, require: localRequire,
      console, setTimeout, clearTimeout, Date, Headers, FormData, AbortController, Uint8Array, URL,
      process: { env: { EXPO_PUBLIC_API_URL: 'https://example.test' } }, ...globals }, { filename: file });
    return module.exports;
  }
  return load;
}
function payload(id = 'sos-1') {
  return { sosId: id, userId: 'owner', userName: 'Name', userPhone: '123', sosType: 'MEDICAL',
    messageType: 'SOS_ALERT', location: { latitude: 12, longitude: 77, accuracy: 0, provider: 'gps' },
    timestamp: new Date().toISOString(), createdAt: new Date().toISOString(), originDeviceId: 'device',
    hopCount: 0, maxHops: 15, relayChain: [], ttlSeconds: 3600, status: 'ACTIVE', deliveryMethod: 'DIRECT_ONLINE' };
}

test('API sends backend field names and keeps credentials out of JSON', async () => {
  let call;
  const { SOSApiService } = loader({}, { fetch: async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ success: true, sos_id: 'sos-1', is_duplicate: true, message: 'ok', server_timestamp: 'now' }));
  } })('src/services/sos-api.service.ts');
  const input = { ...payload(), authToken: 'secret', relayChain: [{ deviceId: 'relay', timestamp: new Date().toISOString(), location: payload().location }] };
  const result = await SOSApiService.sendSOS(input);
  const sent = JSON.parse(call.options.body);
  assert.equal(sent.sos_id, 'sos-1'); assert.equal(sent.location.lat, 12);
  assert.equal(sent.relay_chain[0].device_id, 'relay'); assert.equal(sent.relay_chain[0].location.lng, 77);
  assert.ok(!call.options.body.includes('secret')); assert.equal(call.options.headers.get('Authorization'), 'Bearer secret');
  assert.equal(result.sosId, 'sos-1'); assert.equal(result.isDuplicate, true);
});

test('API rejects HTTP and application failures without retrying 4xx', async () => {
  let calls = 0;
  const load = loader({}, { fetch: async () => { calls++; return new Response(JSON.stringify({ detail: 'Denied' }), { status: 403 }); } });
  await assert.rejects(load('src/services/sos-api.service.ts').SOSApiService.sendSOS(payload()), /Denied/);
  assert.equal(calls, 1);
  const api = loader({}, { fetch: async () => new Response(JSON.stringify({ success: false, message: 'Rejected' })) })('src/services/sos-api.service.ts');
  await assert.rejects(api.SOSApiService.sendSOS(payload()), /Rejected/);
});

test('nearby queries and response mapping follow backend contract', async () => {
  let url;
  const api = loader({}, { fetch: async value => {
    url = value;
    return new Response(JSON.stringify([{ sos_id: 'nearby', user_id: 'owner', user_name: 'Name', sos_type: 'FIRE', message_type: 'SOS_ALERT',
      location: { lat: 10, lng: 20 }, client_timestamp: '2026-10-03T00:00:00Z', created_at: '2026-10-03T00:00:00Z',
      status: 'ACTIVE', hop_count: 1, delivery_method: 'BLE_RELAY', relay_chain: null }]));
  } })('src/services/sos-api.service.ts');
  const events = await api.SOSApiService.getActiveSOS(10,20,7);
  assert.match(url, /radius_km=7/); assert.equal(events[0].sosId, 'nearby');
  assert.equal(events[0].location.longitude, 20);
});

test('BLE round-trip excludes bearer tokens and rejects expired/oversized packets', () => {
  const { encodePayload, decodePayload } = loader()('src/services/ble-codec.ts');
  const encoded = encodePayload({ ...payload(), authToken: 'never-broadcast-this' });
  assert.ok(!Buffer.from(encoded, 'base64').toString().includes('never-broadcast-this'));
  assert.equal(decodePayload(encoded).sosId, 'sos-1');
  assert.throws(() => encodePayload({ ...payload(), timestamp: '2000-01-01T00:00:00Z' }), /expired/);
  assert.throws(() => encodePayload({ ...payload(), message: 'x'.repeat(20000) }), /16 KiB/);
  assert.throws(() => decodePayload(Buffer.from('{}').toString('base64')), /Invalid/);
});

function queueHarness() {
  const store = new Map();
  let locationCalls = 0; let failLocation = false; let blockSend; let online = false; let failSend = false; let failCancel = false; let advertise = false;
  const sent = [];
  const storage = { async getItem(key) { await Promise.resolve(); return store.get(key) ?? null; },
    async setItem(key,value) { await Promise.resolve(); store.set(key,value); } };
  class BLEMeshService {
    async requestPermissions() {}
    async startAdvertising() { if (!advertise) throw Error('No BLE'); }
    async stopAdvertising() {}
  }
  class ApiError extends Error {}
  const api = { setAuthToken() {}, async sendSOS(p) { if (blockSend) await blockSend(); if (failSend) throw Error('Offline'); sent.push(p); return { success: true }; },
    async cancelSOS() { if (failCancel) throw Error('Offline'); return { success: true }; } };
  const load = loader({
    '@react-native-async-storage/async-storage': storage,
    './location.service': { LocationService: { async getCurrentLocation() { locationCalls++; if (failLocation) throw Error("No GPS"); return payload().location; } } },
    './network.service': { NetworkService: { async checkConnectivity() { return { isOnline: online }; } } },
    './origin-security': { signOrigin: async () => ({ certificate: 'test', signedPayload: '{}', signature: 'test' }) },
    'expo-crypto': { randomUUID: require('node:crypto').randomUUID },
    './sos-api.service': { SOSApiService: api, ApiError }, './ble-mesh.service': { BLEMeshService },
  });
  return { service: load('src/services/sos-trigger.service.ts').SOSTriggerService, store, sent,
    setBlockSend(value) { blockSend=value; }, setOnline(value) { online=value; }, setFailSend(value) { failSend=value; }, setFailCancel(value) { failCancel=value; },
    setAdvertise(value) { advertise=value; }, setFailLocation(value) { failLocation=value; }, locationCalls() { return locationCalls; } };
}
const params = { userId:'owner', userName:'Name', userPhone:'123', sosType:'MEDICAL', authToken:'secret' };

test('offline SOS stays queued and concurrent additions are not lost', async () => {
  const h = queueHarness();
  const results = await Promise.all([h.service.triggerSOS(params),h.service.triggerSOS(params)]);
  assert.equal(results[0].deliveryMethod, 'OFFLINE_QUEUED');
  const raw = h.store.get('@suraksha_sos_queue');
  assert.equal(JSON.parse(raw).length, 2); assert.ok(!raw.includes('secret'));
  h.setOnline(true); await h.service.retryPendingQueue();
  assert.equal(h.sent.length, 2); assert.equal(h.store.get('@suraksha_sos_queue'),'[]');
});

test('failed retry remains durable and cancellation cannot resurrect an alert', async () => {
  const h = queueHarness();
  const alert = await h.service.triggerSOS(params);
  h.setOnline(true); h.setFailSend(true);
  await h.service.retryPendingQueue();
  assert.equal(JSON.parse(h.store.get('@suraksha_sos_queue')).length, 1);
  h.setFailCancel(true);
  assert.equal(await h.service.cancelSOS(alert.sosId, 'owner'), false);
  assert.equal(h.store.get('@suraksha_sos_queue'), '[]');
  h.setFailSend(false); await h.service.retryPendingQueue();
  assert.equal(h.sent.length, 0);
  assert.equal(JSON.parse(h.store.get('@suraksha_sos_cancellations')).length, 1);
  h.setFailCancel(false); await h.service.retryPendingQueue();
  assert.equal(h.store.get('@suraksha_sos_cancellations'), '[]');
});

test('expired alerts are discarded without being uploaded', async () => {
  const h = queueHarness();
  h.store.set('@suraksha_sos_queue', JSON.stringify([{ ...payload(), timestamp:'2000-01-01T00:00:00Z' }]));
  h.setOnline(true); await h.service.retryPendingQueue();
  assert.equal(h.sent.length, 0); assert.equal(h.store.get('@suraksha_sos_queue'), '[]');
});


test('real P-256 certificates verify; forged payload, signature and authority fail', async () => {
  const { p256 } = require('@noble/curves/nist.js');
  const { randomBytes } = require('node:crypto');
  const ca = randomBytes(32), device = randomBytes(32);
  const pub = key => Buffer.from(p256.getPublicKey(key, false)).toString('hex');
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = b64({alg:'ES256',typ:'JWT'});
  const claims = b64({sub:'owner',device_id:'device',public_key:pub(device),iss:'suraksha-device-ca',aud:'suraksha-ble',exp:Math.floor(Date.now()/1000)+3600});
  const certificate = `${header}.${claims}.${Buffer.from(p256.sign(Buffer.from(`${header}.${claims}`),ca)).toString('base64url')}`;
  const security = loader({ 'expo-secure-store': {getItemAsync:async key=>key==='suraksha.device.v2' ? JSON.stringify({deviceId:'device',userId:'owner',secret:device.toString('hex'),certificate}) : pub(ca)},
    'expo-crypto': {}, 'react-native': {Platform:{OS:'android'}} })('src/services/origin-security.ts');
  const event = payload();
  const signedPayload = JSON.stringify(security.immutableOrigin(event));
  event.originProof = { certificate, signedPayload, signature:Buffer.from(p256.sign(Buffer.from(signedPayload),device)).toString('hex') };
  await security.verifyOrigin(event);
  const signed = {...event, userName:'Test नमस्ते', message:'Help — test'};
  signed.originProof = await security.signOrigin(signed);
  await security.verifyOrigin(signed);
  const control = {...event, protocolVersion:2, revision:1, messageType:'SOS_CANCEL'};
  control.originProof = await security.signOrigin(control, false);
  await security.verifyOrigin(control);
  await assert.rejects(security.verifyOrigin({...control, messageType:'SOS_ALERT'}), /mismatch/);
  await assert.rejects(security.verifyOrigin({...control, protocolVersion:undefined, revision:undefined, messageType:'SOS_ALERT'}), /mismatch/);
  await assert.rejects(security.verifyOrigin({...control, helperRequested:true}), /mismatch/);
  const noLocation = {...event, location:null};
  noLocation.originProof = await security.signOrigin(noLocation, false);
  await security.verifyOrigin(noLocation);
  assert.equal(JSON.parse(noLocation.originProof.signedPayload).lat, null);
  await assert.rejects(security.verifyOrigin({...noLocation, location:event.location}), /mismatch/);
  assert.equal(p256.verify(Buffer.from(signed.originProof.signature,'hex'),Buffer.from(signed.originProof.signedPayload),p256.getPublicKey(device)),true);
  await assert.rejects(security.verifyOrigin({...event,originProof:{...event.originProof,certificate:'!.invalid.invalid'}}), /encoding/);
  await assert.rejects(security.verifyOrigin({...event, location:{...event.location, latitude:13}}), /mismatch/);
  await assert.rejects(security.verifyOrigin({...event, originProof:{...event.originProof, signature:'00'.repeat(64)}}), /mismatch/);
  await assert.rejects(security.verifyOrigin({...event, userId:'attacker'}), /Untrusted/);
});

test('relay inbox is acknowledged only after persistence and failed uploads remain queued', async () => {
  const store = new Map(); let inbox = ['packet']; let fail = true; let notifications = 0; let advertised = 0;
  const event = {...payload('relay-test'), location:null};
  const load = loader({
    '@react-native-async-storage/async-storage': {getItem:async k=>store.get(k)??null,setItem:async(k,v)=>store.set(k,v)},
    'expo-notifications':{scheduleNotificationAsync:async()=>{notifications++;}},
    'expo-location':{getLastKnownPositionAsync:async()=>({coords:{latitude:12,longitude:77,accuracy:5}})},'expo-background-task':{},
    'react-native':{Platform:{OS:'android'}},
    '../../modules/ble-peripheral':{getInbox:async()=>inbox,acknowledgeInbox:async()=>{assert.equal(JSON.parse(store.get('@suraksha.relay.pending.v2')).length,1);inbox=[];}},
    './ble-codec':{decodePayload:()=>event,isLivePayload:()=>true},
    './origin-security':{verifyOrigin:async()=>{}},
    './session.service':{loadSession:async()=>({user:{user_id:'relay'}})},
    './network.service':{NetworkService:{checkConnectivity:async()=>({isOnline:true})}},
    './sos-api.service':{ApiError:class extends Error {},SOSApiService:{sendSOS:async()=>{if(fail)throw Error('network unavailable');}}},
    './sos-trigger.service':{SOSTriggerService:{getDeviceId:async()=> 'device-b',retryPendingQueue:async()=>{},updateActiveLocations:async()=>{}},bleMeshInstance:{reportReceived(){},prepareRelay:p=>({...p,hopCount:1}),startAdvertising:async()=>{advertised++;},stopAdvertising:async()=>{}}},
  });
  const runtime=load('src/services/mesh-runtime.service.ts');
  await runtime.processMeshWork();
  assert.equal(notifications,1);assert.equal(advertised,1);assert.equal(JSON.parse(store.get('@suraksha.relay.pending.v2')).length,1);
  fail=false;await runtime.processMeshWork();
  assert.equal(store.get('@suraksha.relay.pending.v2'),'[]');assert.equal(notifications,1);
});

test('new nearby alerts and persistent dismissal are independent of a blocked upload', async () => {
  const store = new Map(); let inbox = ['one']; const notifications = [];
  let release; const blocked = new Promise(resolve => { release = resolve; });
  let began; const started = new Promise(resolve => { began = resolve; });
  let dismissed;
  const mocks = {
    '@react-native-async-storage/async-storage': {getItem:async k=>store.get(k)??null,setItem:async(k,v)=>store.set(k,v)},
    'expo-notifications':{scheduleNotificationAsync:async n=>notifications.push(n.identifier),dismissNotificationAsync:async id=>{dismissed=id;}},
    'expo-location':{getLastKnownPositionAsync:async()=>null},'expo-background-task':{},
    'react-native':{Platform:{OS:'android'}},
    '../../modules/ble-peripheral':{getInbox:async()=>[...inbox],acknowledgeInbox:async packet=>{inbox=inbox.filter(x=>x!==packet);}},
    './ble-codec':{decodePayload:id=>payload(id),isLivePayload:()=>true},
    './origin-security':{verifyOrigin:async()=>{}},
    './session.service':{loadSession:async()=>({user:{user_id:'relay'}})},
    './network.service':{NetworkService:{checkConnectivity:async()=>({isOnline:true})}},
    './sos-api.service':{ApiError:class extends Error {},SOSApiService:{sendSOS:async()=>{began(); await blocked;}}},
    './sos-trigger.service':{SOSTriggerService:{getDeviceId:async()=> 'device-b',retryPendingQueue:async()=>{},updateActiveLocations:async()=>{}},bleMeshInstance:{reportReceived(){},prepareRelay:p=>({...p,hopCount:1}),startAdvertising:async()=>{},stopAdvertising:async()=>{}}},
  };
  const runtime = loader(mocks)('src/services/mesh-runtime.service.ts');
  const first = runtime.processMeshWork(); await started;
  inbox=['two']; const second=runtime.processMeshWork();
  // Dismissal shares only the short storage lock, so also waits for packet two's ingestion.
  await runtime.dismissNearbySOS('one');
  assert.deepEqual(notifications,['sos-one','sos-two']);
  assert.equal(dismissed,'sos-one');
  assert.equal((await runtime.nearbyEvents()).map(x=>x.sosId).join(','),'two');
  const restarted = loader(mocks)('src/services/mesh-runtime.service.ts');
  assert.equal((await restarted.nearbyEvents()).map(x=>x.sosId).join(','),'two');
  release(); await Promise.all([first,second]);
  // Completion of upload one must not overwrite packet two's newly queued relay.
  assert.equal(JSON.parse(store.get('@suraksha.relay.pending.v2'))[0].sosId,'two');
  inbox=['one']; await runtime.processMeshWork();
  assert.deepEqual(notifications,['sos-one','sos-two']);
  assert.equal((await runtime.nearbyEvents()).length,1);
});

test('local backend reachability works without public internet', async () => {
  let requested;
  const { NetworkService } = loader({ '@react-native-community/netinfo': {fetch:async()=>({isConnected:true,isInternetReachable:false,type:'wifi'})} },
    {fetch:async url=>{requested=url;return {ok:true};}})('src/services/network.service.ts');
  assert.equal((await NetworkService.checkConnectivity()).isOnline,true);
  assert.equal(requested,'https://example.test/health');
});

test('SOS starts nearby advertising before attempting an online upload', async () => {
  const calls=[]; const store=new Map();
  const service=loader({
    '@react-native-async-storage/async-storage':{getItem:async k=>store.get(k)??null,setItem:async(k,v)=>store.set(k,v)},
    './location.service':{LocationService:{getCurrentLocation:async()=>payload().location}},
    './origin-security':{signOrigin:async()=>({})}, 'expo-crypto':{randomUUID:require('node:crypto').randomUUID},
    './network.service':{NetworkService:{checkConnectivity:async()=>({isOnline:true})}},
    './sos-api.service':{ApiError:class extends Error {},SOSApiService:{setAuthToken(){},sendSOS:async()=>{calls.push('upload');}}},
    './ble-mesh.service':{BLEMeshService:class {async requestPermissions(){} async startAdvertising(){calls.push('advertise');} async stopAdvertising(){} }},
  })('src/services/sos-trigger.service.ts').SOSTriggerService;
  const result=await service.triggerSOS(params);
  assert.deepEqual(calls,['advertise','upload']);
  assert.equal(result.deliveryMethod,'DIRECT_ONLINE');
});

test('cancelling a queued SOS does not wait for an in-flight upload', async () => {
  const h=queueHarness(); const event=await h.service.triggerSOS(params);
  let release; const blocked=new Promise(resolve=>{release=resolve;});
  let began; const started=new Promise(resolve=>{began=resolve;});
  h.setBlockSend(async()=>{began();await blocked;}); h.setOnline(true);
  const retry=h.service.retryPendingQueue();await started;
  assert.equal(await h.service.cancelSOS(event.sosId,'owner'),false);
  assert.equal(h.store.get('@suraksha_sos_queue'),'[]');
  release();await retry;
  assert.equal(h.store.get('@suraksha_sos_queue'),'[]');
});

test('backend setting survives restart and rejects credential/path URLs', async () => {
  const store=new Map();const storage={getItem:async k=>store.get(k)??null,setItem:async(k,v)=>store.set(k,v)};
  const config=loader({'@react-native-async-storage/async-storage':storage})('src/constants/api.ts');
  await config.saveApiOrigin('https://new-server.example:8443/');
  assert.equal(config.apiUrl('/health'),'https://new-server.example:8443/health');
  const restarted=loader({'@react-native-async-storage/async-storage':storage})('src/constants/api.ts');
  await restarted.loadApiSettings();assert.equal(restarted.API_ORIGIN,'https://new-server.example:8443');
  for(const url of ['https://user:secret@example.org','https://example.org/path','https://example.org/?token=x','javascript:alert(1)','http://example.org'])assert.throws(()=>config.normalizeOrigin(url));
});

test('persistent account refresh coalesces concurrent requests and revokes on sign-out', async () => {
  const store=new Map([['suraksha.session.v1',JSON.stringify({provider:'local',accessToken:'expired',refreshToken:'persistent-secret',expiresAt:0,user:{user_id:'u'}})]]);
  let refreshes=0,revocations=0;
  const mocks={ 'expo-secure-store':{getItemAsync:async k=>store.get(k)??null,setItemAsync:async(k,v)=>store.set(k,v),deleteItemAsync:async k=>store.delete(k)},
    'expo-auth-session':{},'react-native':{Platform:{OS:'android'}},
    './timed-fetch':{timedFetch:async url=>{
      if(url.endsWith('/refresh')){refreshes++;await new Promise(r=>setTimeout(r,5));return {ok:true,json:async()=>({access_token:'renewed',expires_in:900})};}
      if(url.endsWith('/logout')){revocations++;return {ok:true};}throw Error(url);
    }} };
  const service=loader(mocks)('src/services/session.service.ts');
  assert.deepEqual(await Promise.all([service.sessionToken(),service.sessionToken()]),['renewed','renewed']);
  assert.equal(refreshes,1);
  const restarted=loader(mocks)('src/services/session.service.ts');assert.equal(await restarted.sessionToken(),'renewed');
  await service.signOut();assert.equal(revocations,1);assert.equal(store.has('suraksha.session.v1'),false);
});

test('IP changes probe without credentials and reject a different backend authority', async () => {
  const store=new Map();const ca='04'+'aa'.repeat(64);let remote=ca,options;
  const load=loader({
    '@react-native-async-storage/async-storage':{getItem:async k=>store.get(k)??null,setItem:async(k,v)=>store.set(k,v)},
    'expo-secure-store':{getItemAsync:async()=>ca},
    './timed-fetch':{timedFetch:async(url,opts)=>{options=opts;return {ok:true,json:async()=>({ca_public_key:remote})};}},
  });
  const service=load('src/services/backend-settings.service.ts');
  await service.checkAndSaveBackend('https://moved.example');assert.equal(options,undefined);
  remote='04'+'bb'.repeat(64);await assert.rejects(service.checkAndSaveBackend('https://unrelated.example'),/different identity/);
  assert.equal(load('src/constants/api.ts').API_ORIGIN,'https://moved.example');
});

test('offline SOS attempts GPS and still advertises when no fix is available', async () => {
  const h = queueHarness(); h.setAdvertise(true); h.setFailLocation(true);
  const event = await h.service.triggerSOS(params);
  assert.equal(h.locationCalls(), 1);
  assert.equal(event.location, null);
  assert.equal(event.deliveryMethod, 'BLE_RELAY');
  assert.equal(JSON.parse(h.store.get('@suraksha_sos_queue'))[0].location, null);
  h.setOnline(true); await h.service.retryPendingQueue();
  assert.equal(h.sent[0].location, null);
});

test('online GPS failure still sends the emergency without coordinates', async () => {
  const h = queueHarness(); h.setOnline(true); h.setFailLocation(true);
  const event = await h.service.triggerSOS(params);
  assert.equal(event.deliveryMethod, 'DIRECT_ONLINE');
  assert.equal(h.sent[0].location, null);
});

test('locationless BLE packets and API submissions preserve null without fake coordinates', () => {
  const load = loader();
  const codec = load('src/services/ble-codec.ts');
  const event = {...payload(), location:null};
  const decoded = codec.decodePayload(codec.encodePayload(event));
  assert.equal(decoded.location, null);
  assert.equal(load('src/services/sos-api.service.ts').toWirePayload(event).location, null);
  assert.equal(codec.isLivePayload({...event, location:{latitude:NaN,longitude:1}}), false);
  assert.equal(codec.isLivePayload({...event, location:undefined}), false);
});

test('Android offline advertising does not require location permission', async () => {
  let requested;
  const permissions = {BLUETOOTH_SCAN:'scan',BLUETOOTH_CONNECT:'connect',BLUETOOTH_ADVERTISE:'advertise',ACCESS_FINE_LOCATION:'gps'};
  const {BLEMeshService} = loader({
    'react-native':{Platform:{OS:'android',Version:36},PermissionsAndroid:{PERMISSIONS:permissions,RESULTS:{GRANTED:'granted'},
      requestMultiple:async values=>{requested=values;return Object.fromEntries(values.map(v=>[v,'granted']));}}},
    '../../modules/ble-peripheral':{},
  })('src/services/ble-mesh.service.ts');
  await new BLEMeshService().requestPermissions(true);
  assert.deepEqual(Array.from(requested), ['connect','advertise']);
});

test('offline SOS includes an available GPS fix', async () => {
  const h = queueHarness(); h.setAdvertise(true);
  const event = await h.service.triggerSOS(params);
  assert.equal(event.location.latitude, 12);
  assert.equal(event.deliveryMethod, 'BLE_RELAY');
});

test('active SOS survives delivery, refreshes once due, and cancellation persists a signed BLE control', async () => {
  const h = queueHarness(); h.setOnline(true);
  const event = await h.service.triggerSOS(params);
  assert.equal((await h.service.activeSOS()).length, 1);
  await h.service.updateActiveLocations();
  assert.equal(h.store.get('@suraksha_sos_queue'), '[]');
  const stored = JSON.parse(h.store.get('@suraksha.active.v2'));
  stored[0].timestamp = new Date(Date.now()-61000).toISOString();
  h.store.set('@suraksha.active.v2', JSON.stringify(stored));
  await h.service.updateActiveLocations({...payload().location, latitude:14});
  let queue = JSON.parse(h.store.get('@suraksha_sos_queue'));
  assert.equal(queue[0].sosId,event.sosId); assert.equal(queue[0].revision,1); assert.equal(queue[0].location.latitude,14);
  await h.service.cancelSOS(event.sosId,'owner');
  assert.equal((await h.service.activeSOS()).length,0);
  const packet = JSON.parse(h.store.get('@suraksha.cancel.packets.v2'))[0];
  assert.equal(packet.messageType,'SOS_CANCEL'); assert.equal(packet.revision,2); assert.ok(packet.originProof);
  await h.service.updateActiveLocations(undefined,true);
  assert.equal(h.store.get('@suraksha_sos_queue'),'[]');
});

test('newer queued location is retained when an older upload completes', async () => {
  const h=queueHarness();const event=await h.service.triggerSOS(params);
  let release,began;const blocked=new Promise(r=>release=r);const started=new Promise(r=>began=r);
  h.setOnline(true);h.setBlockSend(async()=>{began();await blocked;});
  const retry=h.service.retryPendingQueue();await started;
  await h.service.updateActiveLocations({...payload().location, latitude:16},true);
  release();await retry;
  const queued=JSON.parse(h.store.get('@suraksha_sos_queue'));
  assert.equal(queued.length,1);assert.equal(queued[0].revision,1);assert.equal(queued[0].sosId,event.sosId);
});

test('relay updates same SOS, broadcasts cancellation online, and suppresses late alerts after restart', async () => {
  const store=new Map();let inbox=[];const ads=[];const sent=[];
  const mocks={
    '@react-native-async-storage/async-storage':{getItem:async k=>store.get(k)??null,setItem:async(k,v)=>store.set(k,v)},
    'expo-notifications':{scheduleNotificationAsync:async()=>{},dismissNotificationAsync:async()=>{}},
    'expo-location':{getLastKnownPositionAsync:async()=>null},'expo-background-task':{},'react-native':{Platform:{OS:'android'}},
    '../../modules/ble-peripheral':{getInbox:async()=>[...inbox],acknowledgeInbox:async packet=>{inbox=inbox.filter(p=>p!==packet);}},
    './origin-security':{verifyOrigin:async()=>{}},'./session.service':{loadSession:async()=>({user:{user_id:'relay'}})},
    './network.service':{NetworkService:{checkConnectivity:async()=>({isOnline:true})}},
    './sos-api.service':{ApiError:class extends Error{},SOSApiService:{sendSOS:async p=>sent.push(p)}},
    './sos-trigger.service':{SOSTriggerService:{getDeviceId:async()=> 'device-b',retryPendingQueue:async()=>{},updateActiveLocations:async()=>{}},bleMeshInstance:{reportReceived(){},prepareRelay:p=>({...p,hopCount:1}),startAdvertising:async p=>ads.push(p),stopAdvertising:async()=>{}}},
  };
  const load=loader(mocks);let runtime=load('src/services/mesh-runtime.service.ts');const codec=load('src/services/ble-codec.ts');
  const first={...payload(),protocolVersion:2,revision:0};
  const deliver=async p=>{inbox=[codec.encodePayload(p)];await runtime.processMeshWork();};
  await deliver(first);await deliver({...first,revision:1,location:{...first.location,latitude:15}});
  assert.equal((await runtime.nearbyEvents())[0].location.latitude,15);assert.equal(sent.length,2);
  await deliver({...first,revision:2,messageType:'SOS_CANCEL',status:'CANCELLED'});
  assert.equal((await runtime.nearbyEvents()).length,0);assert.equal(ads.at(-1).messageType,'SOS_CANCEL');
  runtime=loader(mocks)('src/services/mesh-runtime.service.ts');await deliver(first);
  assert.equal((await runtime.nearbyEvents()).length,0);assert.equal(sent.length,3);
});

test('helper consent packets are targeted, short-lived, and cannot use legacy alert signatures', () => {
  const codec=loader()('src/services/ble-codec.ts');
  const offer={...payload('offer'),protocolVersion:2,revision:0,messageType:'SOS_HELPER',targetSosId:'sos',targetDeviceId:'device-a',ttlSeconds:300};
  assert.equal(codec.decodePayload(codec.encodePayload(offer)).targetDeviceId,'device-a');
  assert.throws(()=>codec.encodePayload({...offer,protocolVersion:undefined}),/Invalid/);
  assert.throws(()=>codec.encodePayload({...offer,ttlSeconds:3600}),/Invalid/);
  assert.throws(()=>codec.encodePayload({...offer,location:null}),/Invalid/);
  assert.throws(()=>codec.encodePayload({...offer,timestamp:new Date(Date.now()-301000).toISOString()}),/expired/);
});

test('relaying never shares the relay phone location automatically', () => {
  const {BLEMeshService}=loader({'react-native':{},'../../modules/ble-peripheral':{}})('src/services/ble-mesh.service.ts');
  const relayed=new BLEMeshService().prepareRelay(payload(),'relay',payload().location);
  assert.equal(relayed.relayChain[0].location,undefined);
});

test('a durable signed cancellation wins after a crash before alert cleanup', async () => {
  const h=queueHarness();const event=await h.service.triggerSOS(params);
  h.store.set('@suraksha.cancel.packets.v2',JSON.stringify([{...event,protocolVersion:2,revision:1,messageType:'SOS_CANCEL'}]));
  assert.equal((await h.service.activeSOS()).length,0);
  h.setOnline(true);await h.service.retryPendingQueue();
  assert.equal(h.sent.length,0);assert.equal(h.store.get('@suraksha_sos_queue'),'[]');
});


test('helper request signs and queues immediately without requesting GPS again', async () => {
  const h = queueHarness(); h.setAdvertise(true);
  const event = await h.service.triggerSOS(params);
  const before = h.locationCalls(); h.setFailLocation(true);
  await h.service.requestHelper(event.sosId);
  const next = (await h.service.activeSOS())[0];
  assert.equal(h.locationCalls(), before);
  assert.equal(next.helperRequested, true); assert.equal(next.revision, 1);
  assert.ok(next.originProof);
  assert.equal(JSON.parse(h.store.get('@suraksha_sos_queue'))[0].helperRequested, true);
});
