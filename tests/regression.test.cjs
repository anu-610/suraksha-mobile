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
    messageType: 'SOS_ALERT', location: { latitude: 12, longitude: 77, accuracy: 0, provider: 'gps', capturedAt: new Date().toISOString() },
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
  let locationCalls = 0; let failLocation = false; let failSigning = false; let blockSend; let blockAdvertise; let blockGPS; let cached = null; let online = false; let failSend = false; let failCancel = false; let advertise = false;
  const sent = [];
  const storage = { async getItem(key) { await Promise.resolve(); return store.get(key) ?? null; },
    async setItem(key,value) { await Promise.resolve(); store.set(key,value); } };
  class BLEMeshService {
    async requestPermissions() {}
    async startAdvertising() { if (blockAdvertise) await blockAdvertise(); if (!advertise) throw Error('No BLE'); }
    async stopAdvertising() {}
    async retireSOS() {}
  }
  class ApiError extends Error {}
  const api = { setAuthToken() {}, async sendSOS(p) { if (p.messageType === 'SOS_CANCEL') { if (failCancel) throw Error('Offline'); return { success: true }; } if (blockSend) await blockSend(); if (failSend) throw Error('Offline'); sent.push(p); return { success: true }; },
    async cancelSOS() { if (failCancel) throw Error('Offline'); return { success: true }; } };
  const load = loader({
    '@react-native-async-storage/async-storage': storage,
    './location.service': { LocationService: { availableLocation: () => cached, async getCurrentLocation() { locationCalls++; if (blockGPS) await blockGPS(); if (failLocation) throw Error("No GPS"); return payload().location; } } },
    './network.service': { NetworkService: { async checkConnectivity() { return { isOnline: online }; } } },
    './origin-security': { signOrigin: async () => { if (failSigning) throw Error('Expired device certificate'); return { certificate: 'test', signedPayload: '{}', signature: 'test' }; } },
    'expo-crypto': { randomUUID: require('node:crypto').randomUUID },
    './sos-api.service': { SOSApiService: api, ApiError }, './ble-mesh.service': { BLEMeshService },
  });
  const service = load('src/services/sos-trigger.service.ts').SOSTriggerService;
  return { service, store, sent, load,
    async start(values) { const p = await service.triggerSOS(values); await service.updateActiveLocations(); await service.retryPendingQueue(); return p; },
    setFailSigning(value) { failSigning = value; }, setCached(value) { cached = value; }, setBlockGPS(value) { blockGPS = value; }, setBlockAdvertise(value) { blockAdvertise = value; },
    resetRetries() { store.delete('@suraksha.retry.v3'); },
    setBlockSend(value) { blockSend=value; }, setOnline(value) { online=value; }, setFailSend(value) { failSend=value; }, setFailCancel(value) { failCancel=value; },
    setAdvertise(value) { advertise=value; }, setFailLocation(value) { failLocation=value; }, locationCalls() { return locationCalls; } };
}
const params = { userId:'owner', userName:'Name', userPhone:'123', sosType:'MEDICAL', authToken:'secret' };

test('offline SOS stays queued and concurrent additions are not lost', async () => {
  const h = queueHarness();
  const results = await Promise.all([h.start(params),h.start(params)]);
  assert.equal(results[0].deliveryMethod, 'OFFLINE_QUEUED');
  const raw = h.store.get('@suraksha_sos_queue');
  assert.equal(JSON.parse(raw).length, 2); assert.ok(!raw.includes('secret'));
  h.setOnline(true); await h.service.retryPendingQueue();
  assert.ok(h.sent.length >= 2); assert.equal(h.store.get('@suraksha_sos_queue'),'[]');
});

test('failed retry remains durable and cancellation cannot resurrect an alert', async () => {
  const h = queueHarness();
  const alert = await h.start(params);
  h.setOnline(true); h.setFailSend(true);
  await h.service.retryPendingQueue();
  assert.equal(JSON.parse(h.store.get('@suraksha_sos_queue')).length, 1);
  h.setFailCancel(true);
  assert.equal(await h.service.cancelSOS(alert.sosId, 'owner'), false);
  assert.equal(h.store.get('@suraksha_sos_queue'), '[]');
  h.setFailSend(false); await h.service.retryPendingQueue();
  assert.equal(h.sent.length, 0);
  assert.equal(JSON.parse(h.store.get('@suraksha_sos_cancellations')).length, 1);
  h.setFailCancel(false); h.resetRetries(); await h.service.retryPendingQueue();
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
    './sos-api.service':{ApiError:class extends Error {},SOSApiService:{sendSOS:async()=>{if(fail)throw Error('network unavailable'); return {success:true};}}},
    './sos-trigger.service':{SOSTriggerService:{getDeviceId:async()=> 'device-b',retryPendingQueue:async()=>{},updateActiveLocations:async()=>{}},bleMeshInstance:{reportReceived(){},prepareRelay:p=>({...p,hopCount:1}),startAdvertising:async()=>{advertised++;},stopAdvertising:async()=>{},retireSOS:async()=>{}}},
  });
  const runtime=load('src/services/mesh-runtime.service.ts');
  await runtime.processMeshWork();
  assert.equal(notifications,1);assert.ok(advertised>=1);assert.equal(JSON.parse(store.get('@suraksha.relay.pending.v2')).length,1);
  fail=false;store.delete('@suraksha.retry.v3');await runtime.processMeshWork();
  assert.equal(JSON.parse(store.get('@suraksha.relay.forwarded.v1')).length,1);assert.equal(notifications,1);
  assert.equal(JSON.parse(store.get('@suraksha.relay.pending.v2')).length,1); // radio retry survives HTTP delivery
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
    './sos-api.service':{ApiError:class extends Error {},SOSApiService:{sendSOS:async()=>{began(); await blocked; return {success:true};}}},
    './sos-trigger.service':{SOSTriggerService:{getDeviceId:async()=> 'device-b',retryPendingQueue:async()=>{},updateActiveLocations:async()=>{}},bleMeshInstance:{reportReceived(){},prepareRelay:p=>({...p,hopCount:1}),startAdvertising:async()=>{},stopAdvertising:async()=>{},retireSOS:async()=>{}}},
  };
  const runtime = loader(mocks)('src/services/mesh-runtime.service.ts');
  const first = runtime.processMeshWork(); await started;
  inbox=['two']; const second=runtime.processMeshWork();
  // Dismissal shares only the short storage lock, so also waits for packet two's ingestion.
  await runtime.dismissNearbySOS('one');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(notifications,['sos-one','sos-two']);
  assert.equal(dismissed,'helper-one');
  assert.equal((await runtime.nearbyEvents()).map(x=>x.sosId).join(','),'two');
  const restarted = loader(mocks)('src/services/mesh-runtime.service.ts');
  assert.equal((await restarted.nearbyEvents()).map(x=>x.sosId).join(','),'two');
  release(); await Promise.all([first,second]);
  // Completion of upload one must not overwrite packet two's newly queued relay.
  assert.ok(JSON.parse(store.get('@suraksha.relay.pending.v2')).some(p=>p.sosId==='two'));
  inbox=['one']; await runtime.processMeshWork();
  assert.deepEqual(notifications,['sos-one','sos-two']);
  assert.equal((await runtime.nearbyEvents()).length,1);
});

test('local Wi-Fi without public internet allows uploads without a health probe gate', async () => {
  let state={isConnected:true,isInternetReachable:false,type:'wifi'}; let probes=0;
  const { NetworkService } = loader({ '@react-native-community/netinfo': {fetch:async()=>state} },
    {fetch:async()=>{probes++;throw Error('probe must not gate uploads');}})('src/services/network.service.ts');
  assert.equal((await NetworkService.checkConnectivity()).isOnline,true);
  state={isConnected:null,isInternetReachable:null,type:'unknown'};
  assert.equal((await NetworkService.checkConnectivity()).isOnline,true); // undecided: try, retry policy throttles
  state={isConnected:false,isInternetReachable:false,type:'none'};
  assert.equal((await NetworkService.checkConnectivity()).isOnline,false);
  assert.equal(probes,0);
});

test('a BLE inbox failure does not block uploads of already queued relays', async () => {
  const h=relayHarness({online:true});
  const queued={...payload('queued-relay'),hopCount:1,relayChain:[{deviceId:'device-a',timestamp:new Date().toISOString()}]};
  h.store.set('@suraksha.relay.pending.v2',JSON.stringify([queued]));
  h.store.set('@suraksha.nearby.v2','{broken');
  await assert.rejects(h.deliver({...payload('new-arrival'),originDeviceId:'device-c'}),/JSON/);
  assert.ok(h.sent.some(p=>p.sosId==='queued-relay'));
});

test('one failing inbox packet does not stop later packets or the upload', async () => {
  const store=new Map();let inbox=['bad','good'];const sent=[];
  const runtime=loader({
    '@react-native-async-storage/async-storage':{getItem:async k=>store.get(k)??null,setItem:async(k,v)=>store.set(k,v)},
    'expo-notifications':{scheduleNotificationAsync:async()=>{},dismissNotificationAsync:async()=>{}},
    'expo-location':{getLastKnownPositionAsync:async()=>null},'expo-background-task':{},'react-native':{Platform:{OS:'android'}},
    '../../modules/ble-peripheral':{getInbox:async()=>[...inbox],acknowledgeInbox:async p=>{if(p==='bad')throw Error('native inbox busy');inbox=inbox.filter(v=>v!==p);}},
    './ble-codec':{decodePayload:id=>({...payload(id),originDeviceId:'device-a'}),isLivePayload:()=>true},
    './origin-security':{verifyOrigin:async()=>{}},
    './session.service':{loadSession:async()=>({user:{user_id:'relay',name:'Relay'}})},
    './network.service':{NetworkService:{checkConnectivity:async()=>({isOnline:true})}},
    './mesh-receipts':{queuePeerReceipt:async()=>{},queueServerReceipt:async()=>{}},
    './sos-api.service':{ApiError:class extends Error {},SOSApiService:{sendSOS:async p=>{sent.push(p.sosId);return {success:true};}}},
    './sos-trigger.service':{SOSTriggerService:{getDeviceId:async()=>'device-b',retryPendingQueue:async()=>{},updateActiveLocations:async()=>{}},bleMeshInstance:{reportReceived(){},prepareRelay:p=>({...p,hopCount:1}),startAdvertising:async()=>{},retireSOS:async()=>{}}},
  })('src/services/mesh-runtime.service.ts');
  await assert.rejects(runtime.processMeshWork(),/native inbox busy/);
  assert.deepEqual(inbox,['bad']); // retried next tick
  assert.deepEqual(sent.sort(),['bad','good']);
});

test('an unverifiable server receipt still completes the relay upload and the next one', async () => {
  const store=new Map();const sent=[];
  const relays=['first','second'].map(id=>({...payload(id),hopCount:1}));
  store.set('@suraksha.relay.pending.v2',JSON.stringify(relays));
  const runtime=loader({
    '@react-native-async-storage/async-storage':{getItem:async k=>store.get(k)??null,setItem:async(k,v)=>store.set(k,v)},
    'expo-notifications':{},'expo-location':{},'expo-background-task':{},'react-native':{Platform:{OS:'android'}},
    '../../modules/ble-peripheral':{getInbox:async()=>[],acknowledgeInbox:async()=>{}},
    './origin-security':{verifyOrigin:async()=>{}},
    './session.service':{loadSession:async()=>({user:{user_id:'relay',name:'Relay'}})},
    './network.service':{NetworkService:{checkConnectivity:async()=>({isOnline:true})}},
    './mesh-receipts':{queuePeerReceipt:async()=>{},queueServerReceipt:async()=>{throw Error('No trusted server receipt authority');}},
    './sos-api.service':{ApiError:class extends Error {},SOSApiService:{sendSOS:async p=>{sent.push(p.sosId);return {success:true,receipt:'token'};}}},
    './sos-trigger.service':{SOSTriggerService:{getDeviceId:async()=>'device-b',retryPendingQueue:async()=>{},updateActiveLocations:async()=>{}},bleMeshInstance:{startAdvertising:async()=>{},retireSOS:async()=>{}}},
  })('src/services/mesh-runtime.service.ts');
  await runtime.processMeshWork();
  assert.deepEqual(sent,['first','second']);
  await runtime.processMeshWork();
  assert.equal(sent.length,2); // marked forwarded, not re-uploaded forever
});

test('Bluetooth off asks once, never loops on resume, and still queues the SOS', async () => {
  let dialogs=0;let on=false;const ads=[];
  const peripheral={isBluetoothEnabled:async()=>on,requestEnableBluetooth:async()=>{dialogs++;await new Promise(r=>setTimeout(r,5));return false;},
    initialize:async()=>true,onSOSReceived:()=>null,onError:()=>null,startAdvertising:async p=>{ads.push(p);return true;}};
  const rn={Platform:{OS:'android',Version:34},PermissionsAndroid:{PERMISSIONS:{BLUETOOTH_CONNECT:'c',BLUETOOTH_ADVERTISE:'a',BLUETOOTH_SCAN:'s',ACCESS_FINE_LOCATION:'l'},
    RESULTS:{GRANTED:'granted'},request:async()=>'granted',check:async()=>true,requestMultiple:async list=>Object.fromEntries(list.map(p=>[p,p==='l'?'denied':'granted']))}};
  const load=loader({'react-native':rn,'../../modules/ble-peripheral':peripheral});
  const mesh=new (load('src/services/ble-mesh.service.ts').BLEMeshService)();
  await mesh.requestPermissions(); // Android 12+: location optional for relay
  assert.deepEqual(await Promise.all([mesh.ensureBluetoothOn(),mesh.ensureBluetoothOn()]),[false,false]);
  assert.equal(dialogs,1);
  mesh.askOnOpen(); assert.equal(dialogs,1); // the resume right after our own dialog
  assert.equal(await mesh.nearbyProblem(),'bluetooth');
  on=true; assert.equal(await mesh.ensureBluetoothOn(),true); assert.equal(dialogs,1);
  assert.equal(await mesh.nearbyProblem(),null);
  const store=new Map();on=false;
  const service=loader({
    '@react-native-async-storage/async-storage':{getItem:async k=>store.get(k)??null,setItem:async(k,v)=>store.set(k,v)},
    './location.service':{LocationService:{availableLocation:()=>null,getCurrentLocation:async()=>{throw Error('No GPS');}}},
    './origin-security':{signOrigin:async()=>({})},
    './network.service':{NetworkService:{checkConnectivity:async()=>({isOnline:false})}},
    './sos-api.service':{ApiError:class extends Error {},SOSApiService:{setAuthToken(){}}},
    './ble-mesh.service':{BLEMeshService:class {async requestPermissions(){} async startAdvertising(p){ads.push(p);} async ensureBluetoothOn(){asked++;return false;}}},
  })('src/services/sos-trigger.service.ts').SOSTriggerService;
  let asked=0;
  const sos=await service.triggerSOS(params);
  await new Promise(r=>setTimeout(r,20));
  assert.ok(ads.some(p=>p.sosId===sos.sosId)); // handed to native queue anyway
  assert.equal(asked,1);
  mesh.askOnOpen(); await new Promise(r=>setTimeout(r,20)); assert.equal(dialogs,1); // Bluetooth was on by then
});

test('an unverifiable server receipt does not keep the sender SOS queued forever', async () => {
  const store=new Map();let uploads=0;
  const service=loader({
    '@react-native-async-storage/async-storage':{getItem:async k=>store.get(k)??null,setItem:async(k,v)=>store.set(k,v)},
    './location.service':{LocationService:{availableLocation:()=>null,getCurrentLocation:async()=>payload().location}},
    './origin-security':{signOrigin:async()=>({}),readServerReceipt:async()=>{throw Error('Untrusted server receipt');}},
    './network.service':{NetworkService:{checkConnectivity:async()=>({isOnline:true})}},
    './sos-api.service':{ApiError:class extends Error {},SOSApiService:{setAuthToken(){},sendSOS:async()=>{uploads++;return {success:true,receipt:'token'};}}},
    './ble-mesh.service':{BLEMeshService:class {async requestPermissions(){} async startAdvertising(){} async retireSOS(){} }},
  })('src/services/sos-trigger.service.ts').SOSTriggerService;
  await service.triggerSOS(params); await service.updateActiveLocations(); await service.retryPendingQueue(); await service.retryPendingQueue();
  assert.equal(JSON.parse(store.get('@suraksha_sos_queue')).length,0);
  const delivery=JSON.parse(store.get('@suraksha.delivery.v3'))[0];
  assert.equal(delivery.serverRevision,delivery.revision); assert.equal(delivery.error,undefined);
  const done=uploads; await service.retryPendingQueue(); assert.equal(uploads,done);
});

test('SOS starts nearby advertising before attempting an online upload', async () => {
  const calls=[]; const store=new Map();
  const service=loader({
    '@react-native-async-storage/async-storage':{getItem:async k=>store.get(k)??null,setItem:async(k,v)=>store.set(k,v)},
    './location.service':{LocationService:{availableLocation:()=>null,getCurrentLocation:async()=>payload().location}},
    './origin-security':{signOrigin:async()=>({})}, 'expo-crypto':{randomUUID:require('node:crypto').randomUUID},
    './network.service':{NetworkService:{checkConnectivity:async()=>({isOnline:true})}},
    './sos-api.service':{ApiError:class extends Error {},SOSApiService:{setAuthToken(){},sendSOS:async()=>{calls.push('upload'); return {success:true};}}},
    './ble-mesh.service':{BLEMeshService:class {async requestPermissions(){} async startAdvertising(){calls.push('advertise');} async stopAdvertising(){} }},
  })('src/services/sos-trigger.service.ts').SOSTriggerService;
  const result=await service.triggerSOS(params);
  await service.updateActiveLocations(); await service.retryPendingQueue();
  assert.ok(calls.includes('advertise') && calls.includes('upload'));
  assert.equal(result.deliveryMethod,'OFFLINE_QUEUED');
});

test('cancelling a queued SOS does not wait for an in-flight upload', async () => {
  const h=queueHarness(); const event=await h.start(params);
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
  const event = await h.start(params);
  assert.equal(h.locationCalls(), 1);
  assert.equal(event.location, null);
  assert.equal(event.deliveryMethod, 'OFFLINE_QUEUED');
  assert.equal(JSON.parse(h.store.get('@suraksha_sos_queue'))[0].location, null);
  h.setOnline(true); await h.service.retryPendingQueue();
  assert.equal(h.sent[0].location, null);
});

test('online GPS failure still sends the emergency without coordinates', async () => {
  const h = queueHarness(); h.setOnline(true); h.setFailLocation(true);
  const event = await h.start(params);
  assert.equal(event.deliveryMethod, 'OFFLINE_QUEUED');
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
  const h = queueHarness(); h.setAdvertise(true); h.setCached(payload().location);
  const event = await h.start(params);
  assert.equal(event.location.latitude, 12);
  assert.equal(event.deliveryMethod, 'OFFLINE_QUEUED');
});

test('active SOS survives delivery, refreshes once due, and cancellation persists a signed BLE control', async () => {
  const h = queueHarness(); h.setOnline(true);
  const event = await h.start(params);
  assert.equal((await h.service.activeSOS()).length, 1);
  await h.service.updateActiveLocations();
  assert.equal(h.store.get('@suraksha_sos_queue'), '[]');
  const stored = JSON.parse(h.store.get('@suraksha.active.v2'));
  stored[0].timestamp = new Date(Date.now()-61000).toISOString();
  h.store.set('@suraksha.active.v2', JSON.stringify(stored));
  await h.service.updateActiveLocations({...payload().location, latitude:14});
  let queue = JSON.parse(h.store.get('@suraksha_sos_queue'));
  assert.equal(queue[0].sosId,event.sosId); assert.equal(queue[0].revision,2); assert.equal(queue[0].location.latitude,14);
  await h.service.cancelSOS(event.sosId,'owner');
  assert.equal((await h.service.activeSOS()).length,0);
  const packet = JSON.parse(h.store.get('@suraksha.cancel.packets.v2'))[0];
  assert.equal(packet.messageType,'SOS_CANCEL'); assert.equal(packet.revision,3); assert.ok(packet.originProof);
  await h.service.updateActiveLocations(undefined,true);
  assert.equal(h.store.get('@suraksha_sos_queue'),'[]');
});

test('newer queued location is retained when an older upload completes', async () => {
  const h=queueHarness();const event=await h.start(params);
  let release,began;const blocked=new Promise(r=>release=r);const started=new Promise(r=>began=r);
  h.setOnline(true);h.setBlockSend(async()=>{began();await blocked;});
  const retry=h.service.retryPendingQueue();await started;
  await h.service.updateActiveLocations({...payload().location, latitude:16},true);
  release();await retry;
  const queued=JSON.parse(h.store.get('@suraksha_sos_queue'));
  assert.equal(queued.length,1);assert.equal(queued[0].revision,2);assert.equal(queued[0].sosId,event.sosId);
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
    './sos-trigger.service':{SOSTriggerService:{getDeviceId:async()=> 'device-b',retryPendingQueue:async()=>{},updateActiveLocations:async()=>{}},bleMeshInstance:{reportReceived(){},prepareRelay:p=>({...p,hopCount:1}),startAdvertising:async p=>ads.push(p),stopAdvertising:async()=>{},retireSOS:async()=>{}}},
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
  const h=queueHarness();const event=await h.start(params);
  h.store.set('@suraksha.cancel.packets.v2',JSON.stringify([{...event,protocolVersion:2,revision:1,messageType:'SOS_CANCEL'}]));
  assert.equal((await h.service.activeSOS()).length,0);
  h.setOnline(true);await h.service.retryPendingQueue();
  assert.equal(h.sent.length,0);assert.equal(h.store.get('@suraksha_sos_queue'),'[]');
});


test('helper request signs and queues immediately without requesting GPS again', async () => {
  const h = queueHarness(); h.setAdvertise(true);
  const event = await h.start(params);
  const before = h.locationCalls(); h.setFailLocation(true);
  await h.service.requestHelper(event.sosId);
  const next = (await h.service.activeSOS())[0];
  assert.equal(h.locationCalls(), before);
  assert.equal(next.helperRequested, true); assert.equal(next.revision, 2);
  assert.ok(next.originProof);
  assert.equal(JSON.parse(h.store.get('@suraksha_sos_queue'))[0].helperRequested, true);
});

// A stuck device boundary must not hold local cancellation or initial dispatch.
test('first SOS is saved and uploaded while GPS and Bluetooth startup remain blocked', async () => {
  const h = queueHarness(); h.setOnline(true);
  let releaseGPS, releaseBLE;
  const gps = new Promise(r => { releaseGPS = r; });
  const ble = new Promise(r => { releaseBLE = r; });
  h.setBlockGPS(() => gps); h.setBlockAdvertise(() => ble);
  const event = await h.service.triggerSOS(params);
  await h.service.retryPendingQueue();
  assert.equal(event.location, null);
  assert.equal(h.sent[0].sosId, event.sosId);
  assert.equal(h.sent[0].location, null);
  await h.service.cancelSOS(event.sosId, 'owner');
  assert.equal((await h.service.activeSOS()).length, 0);
  assert.equal(JSON.parse(h.store.get('@suraksha.cancel.packets.v2'))[0].messageType, 'SOS_CANCEL');
  releaseGPS(); releaseBLE();
  await h.service.updateActiveLocations();
  assert.equal(h.store.get('@suraksha_sos_queue'), '[]');
});

test('cancellation is persisted while a location-update advertisement is stalled', async () => {
  const h = queueHarness(); const event = await h.start(params);
  let release, began; const stalled = new Promise(r => { release = r; }); const started = new Promise(r => { began = r; });
  h.setBlockAdvertise(() => { began(); return stalled; });
  await h.service.updateActiveLocations(payload().location, true); await started;
  await h.service.cancelSOS(event.sosId, 'owner');
  assert.equal((await h.service.activeSOS()).length, 0);
  assert.equal(h.store.get('@suraksha_sos_queue'), '[]');
  release();
});

test('each helper request gets a new signed ID and withdrawal retains that ID', async () => {
  const h = queueHarness(); const event = await h.start(params);
  const before = h.locationCalls();
  await h.service.requestHelper(event.sosId);
  const first = (await h.service.activeSOS())[0];
  await h.service.requestHelper(event.sosId);
  const second = (await h.service.activeSOS())[0];
  assert.notEqual(first.helperRequestId, second.helperRequestId);
  assert.equal(second.helperState, 'pending');
  assert.equal(h.locationCalls(), before);
  await h.service.requestHelper(event.sosId, true);
  const withdrawn = (await h.service.activeSOS())[0];
  assert.equal(withdrawn.helperRequestId, second.helperRequestId);
  assert.equal(withdrawn.helperRequested, false);
  assert.equal(withdrawn.helperState, 'withdrawn');
});

test('Retry-After throttles relay uploads without blocking a new cancellation', async () => {
  const store = new Map();
  const load = loader({'@react-native-async-storage/async-storage':{getItem:async k=>store.get(k)??null,setItem:async(k,v)=>store.set(k,v)}});
  const retry = load('src/services/retry-policy.ts');
  const first = payload('busy');
  await retry.uploadFailed(first, {status:429,retryAfterMs:60000});
  assert.equal(await retry.mayUpload(first), false);
  assert.equal(await retry.mayUpload(payload('another')), false);
  assert.equal(await retry.mayUpload({...first,messageType:'SOS_CANCEL',revision:1}), true);
  await retry.uploadFailed({...first,revision:2}, {status:422});
  const saved = JSON.parse(store.get('@suraksha.retry.v3')); saved.cooldown = 0;
  store.set('@suraksha.retry.v3',JSON.stringify(saved));
  assert.equal(await retry.mayUpload({...first,revision:2}), false);
  assert.equal(await retry.mayUpload({...first,revision:3}), true);
});

test('HTTP validation errors exclude submitted secrets and expose Retry-After', async () => {
  const load = loader({}, {fetch:async()=>new Response(JSON.stringify({detail:[{loc:['body','location'],msg:'Invalid coordinates',input:'private-value'}]}),{status:429,headers:{'Retry-After':'35'}})});
  await assert.rejects(load('src/services/sos-api.service.ts').SOSApiService.sendSOS(payload()), error =>
    error.status===429 && error.retryAfterMs===35000 && error.message.includes('location') && !error.message.includes('private-value'));
});

test('delivery state advances on receipts and a delayed alert receipt cannot undo cancellation', async () => {
  const h=queueHarness();const event=await h.start(params);
  const delivery=h.load('src/services/delivery.service.ts');
  const receipt={...event,targetSosId:event.sosId,targetDeviceId:event.originDeviceId,receiptKind:'peer',receiptMessageType:'SOS_ALERT',receiptRevision:0,receiptStatus:'received'};
  await h.service.acceptReceipt(receipt);
  assert.match(delivery.deliveryLabel((await delivery.deliveryStates('owner'))[0]),/another phone/);
  await h.service.cancelSOS(event.sosId,'owner');
  await h.service.acceptReceipt({...receipt,receiptKind:'server',receiptMessageType:'SOS_CANCEL',receiptStatus:'cancelled'});
  await h.service.acceptReceipt({...receipt,receiptKind:'server',receiptStatus:'accepted'});
  assert.match(delivery.deliveryLabel((await delivery.deliveryStates('owner'))[0]),/Cancellation confirmed/);
  assert.equal((await h.service.activeSOS()).length,0);
});

function relayHarness({online=false,deviceId='device-b'}={}) {
  const store=new Map();let inbox=[];const ads=[],sent=[],notices=[],receipts=[],retired=[];
  let blockGPS, serverReply;
  const prepare=loader({'react-native':{},'../../modules/ble-peripheral':{}})('src/services/ble-mesh.service.ts').BLEMeshService.prototype.prepareRelay;
  const mocks={
    '@react-native-async-storage/async-storage':{getItem:async k=>store.get(k)??null,setItem:async(k,v)=>store.set(k,v)},
    'expo-notifications':{scheduleNotificationAsync:async p=>notices.push(p),dismissNotificationAsync:async()=>{}},
    'expo-location':{getLastKnownPositionAsync:async()=>null},'expo-background-task':{},'react-native':{Platform:{OS:'android'}},
    '../../modules/ble-peripheral':{getInbox:async()=>[...inbox],acknowledgeInbox:async p=>{inbox=inbox.filter(v=>v!==p);}},
    './origin-security':{verifyOrigin:async()=>{},signOrigin:async()=>({certificate:'test',signedPayload:'{}',signature:'test'}),readServerReceipt:async token=>({...JSON.parse(token),serverReceipt:token})},
    './session.service':{loadSession:async()=>({user:{user_id:'helper',name:'Helper'}})},
    './network.service':{NetworkService:{checkConnectivity:async()=>({isOnline:online})}},
    './location.service':{LocationService:{getCurrentLocation:async()=>{if(blockGPS)await blockGPS();return payload().location;}}},
    './sos-api.service':{ApiError:class extends Error{},SOSApiService:{sendSOS:async p=>{sent.push(p);return {success:true,receipt:serverReply?JSON.stringify(serverReply):undefined};}}},
    './sos-trigger.service':{SOSTriggerService:{getDeviceId:async()=>deviceId,activeSOS:async()=>JSON.parse(store.get('@suraksha.active.v2')??'[]'),
      acceptReceipt:async p=>{if(p.targetDeviceId===deviceId)receipts.push(p);},retryPendingQueue:async()=>{},updateActiveLocations:async()=>{}},
      bleMeshInstance:{reportReceived(){},prepareRelay:(p,id)=>prepare(p,id),startAdvertising:async p=>{if(!p.uploadOnly)ads.push(p);},retireSOS:async id=>retired.push(id)}},
  };
  const load=loader(mocks);const runtime=load('src/services/mesh-runtime.service.ts'),codec=load('src/services/ble-codec.ts');
  return {store,ads,sent,notices,receipts,retired,load,runtime,
    setReceipt(value){serverReply=value;},blockGPS(value){blockGPS=value;},setOnline(value){online=value;},
    async deliver(packet){inbox.push(codec.encodePayload(packet));await runtime.processMeshWork();}};
}
const helperRequest = () => ({...payload(),protocolVersion:3,revision:1,helperRequested:true,helperState:'pending',
  helperRequestId:'request-1',helperRequestExpiresAt:new Date(Date.now()+300000).toISOString()});

test('the last allowed hop uploads to the backend without further BLE forwarding', async () => {
  const h=relayHarness({online:true});
  const last={...payload('last-hop'),hopCount:15,maxHops:15,relayChain:[]};
  await h.deliver(last);
  assert.equal(h.sent.length,1);assert.equal(h.sent[0].hopCount,15);
  assert.equal(h.ads.filter(p=>p.sosId===last.sosId).length,0);
  const uploadOnly=JSON.parse(h.store.get('@suraksha.relay.pending.v2')).find(p=>p.sosId===last.sosId);
  assert.equal(uploadOnly.uploadOnly,true);
});

test('new request IDs notify and unhide the event after a previous helper request was dismissed', async () => {
  const h=relayHarness();const first=helperRequest();
  await h.deliver(first);await h.runtime.dismissNearbySOS(first.sosId);
  assert.equal((await h.runtime.nearbyEvents()).length,0);
  await h.deliver({...first,revision:2,helperRequestId:'request-2'});
  assert.equal((await h.runtime.nearbyEvents()).length,1);
  assert.equal(h.notices.filter(p=>p.identifier==='helper-sos-1').length,2);
});

test('declining works offline without a location, and withdrawal supersedes the accepted snapshot', async () => {
  const h=relayHarness();const event=helperRequest();await h.deliver(event);
  const consent=h.load('src/services/helper-consent.service.ts');
  await consent.respondToHelper(event,'declined');
  let choice=(await consent.helperChoices('helper'))[0];
  assert.equal(choice.packet.helperState,'declined');assert.equal(choice.packet.location,null);
  h.setOnline(true);await consent.respondToHelper(event,'accepted');
  choice=(await consent.helperChoices('helper'))[0];assert.ok(choice.packet.location);
  const id=choice.packet.sosId,revision=choice.packet.revision;
  await consent.respondToHelper(event,'withdrawn');
  choice=(await consent.helperChoices('helper'))[0];
  assert.equal(choice.packet.sosId,id);assert.equal(choice.packet.revision,revision+1);
  assert.equal(choice.packet.helperState,'withdrawn');assert.equal(choice.packet.location,null);
  const queued=JSON.parse(h.store.get('@suraksha.relay.pending.v2')).filter(p=>p.sosId===id);
  assert.equal(queued.length,1);assert.equal(queued[0].location,null);
});

test('cancellation during helper GPS acquisition prevents the snapshot from being shared', async () => {
  const h=relayHarness({online:true});const event=helperRequest();await h.deliver(event);
  let release,began;const blocked=new Promise(r=>release=r),started=new Promise(r=>began=r);
  h.blockGPS(()=>{began();return blocked;});
  const consent=h.load('src/services/helper-consent.service.ts');
  const sharing=consent.respondToHelper(event,'accepted');
  const rejected=assert.rejects(sharing,/changed|expired|withdrawn/);
  await started;
  await h.deliver({...event,revision:2,messageType:'SOS_CANCEL',location:null,helperRequested:false,helperState:'withdrawn'});
  release();await rejected;
  assert.equal(h.ads.some(p=>p.messageType==='SOS_HELPER'&&p.location),false);
});

test('withdrawn helper location cannot be restored by delayed acceptance at the sender', async () => {
  const h=relayHarness({deviceId:'device'});const event=helperRequest();
  h.store.set('@suraksha.active.v2',JSON.stringify([event]));
  const accepted={...event,sosId:'offer',userId:'helper',userName:'Helper',originDeviceId:'device-b',helperRequested:false,
    messageType:'SOS_HELPER',helperState:'accepted',targetSosId:event.sosId,targetDeviceId:'device',ttlSeconds:300};
  await h.deliver(accepted);
  await h.deliver({...accepted,revision:2,helperState:'withdrawn',location:null});
  await h.deliver(accepted);
  const offers=await h.runtime.helperOffers(event.sosId);
  assert.equal(offers.length,1);assert.equal(offers[0].helperState,'withdrawn');assert.equal(offers[0].location,null);
});

test('real server receipts reject forged targets, revisions, keys, expiry and device-certificate audience', async () => {
  const { p256 }=require('@noble/curves/nist.js');const {randomBytes}=require('node:crypto');const ca=randomBytes(32);
  const publicKey=Buffer.from(p256.getPublicKey(ca,false)).toString('hex');
  const security=loader({'expo-secure-store':{getItemAsync:async()=>publicKey},'react-native':{Platform:{OS:'android'}}})('src/services/origin-security.ts');
  const packet={...payload('receipt-test'),protocolVersion:3,revision:0,messageType:'SOS_ACK',location:null,
    userId:'suraksha-server',userName:'Suraksha server',originDeviceId:'suraksha-server',targetSosId:'original-sos',targetDeviceId:'device-a',
    receiptKind:'server',receiptRevision:4,receiptMessageType:'SOS_ALERT',receiptStatus:'accepted',receiptUserId:'owner'};
  const token=(changes={},key=ca)=>{
    const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
    const data=`${b64({alg:'ES256',typ:'JWT'})}.${b64({iss:'suraksha-device-ca',aud:'suraksha-receipt',exp:Math.floor(Date.now()/1000)+3600,packet,...changes})}`;
    return `${data}.${Buffer.from(p256.sign(Buffer.from(data),key)).toString('base64url')}`;
  };
  const receipt=await security.readServerReceipt(token());await security.verifyOrigin(receipt);
  const codec=loader()('src/services/ble-codec.ts');assert.equal(codec.isLivePayload(receipt),true);
  await assert.rejects(security.verifyOrigin({...receipt,targetDeviceId:'attacker'}),/mismatch/);
  await assert.rejects(security.verifyOrigin({...receipt,receiptRevision:99}),/mismatch/);
  await assert.rejects(security.readServerReceipt(token({aud:'suraksha-ble'})),/Untrusted/);
  await assert.rejects(security.readServerReceipt(token({exp:1})),/Untrusted/);
  await assert.rejects(security.readServerReceipt(token({},randomBytes(32))),/Untrusted/);
});

test('protocol v3 signs GPS freshness and helper request state', async () => {
  const {p256}=require('@noble/curves/nist.js');const {randomBytes}=require('node:crypto');const ca=randomBytes(32),device=randomBytes(32);
  const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');const pub=value=>Buffer.from(p256.getPublicKey(value,false)).toString('hex');
  const encoded=`${b64({alg:'ES256'})}.${b64({sub:'owner',device_id:'device',public_key:pub(device),iss:'suraksha-device-ca',aud:'suraksha-ble',exp:Math.floor(Date.now()/1000)+3600})}`;
  const certificate=`${encoded}.${Buffer.from(p256.sign(Buffer.from(encoded),ca)).toString('base64url')}`;
  const security=loader({'expo-secure-store':{getItemAsync:async key=>key==='suraksha.device.v2'?JSON.stringify({deviceId:'device',userId:'owner',secret:device.toString('hex'),certificate}):pub(ca)},'react-native':{Platform:{OS:'android'}}})('src/services/origin-security.ts');
  const event=helperRequest();event.originProof=await security.signOrigin(event,false);await security.verifyOrigin(event);
  for(const changed of [{...event,helperRequestId:'different'},{...event,helperState:'withdrawn'},
    {...event,location:{...event.location,capturedAt:new Date(Date.now()-60000).toISOString()}},
    {...event,location:{...event.location,accuracy:123}}]) await assert.rejects(security.verifyOrigin(changed),/mismatch/);
});

test('legacy packets cannot inject unsigned v3 consent state or GPS capture time', () => {
  const codec=loader()('src/services/ble-codec.ts');
  const legacy={...payload(),protocolVersion:2,revision:0,helperRequested:true,helperRequestId:'injected',helperState:'withdrawn'};
  const decoded=codec.decodePayload(codec.encodePayload(legacy));
  assert.equal(decoded.helperRequestId,undefined);assert.equal(decoded.helperState,undefined);
  assert.equal(decoded.location.capturedAt,undefined);
});

test('offline A to offline B to online C returns acceptance and cancellation receipts through B', async () => {
  const a=relayHarness({deviceId:'device'}),b=relayHarness({deviceId:'b'}),c=relayHarness({deviceId:'c',online:true});
  const source={...payload('three-phone'),protocolVersion:3,revision:0};
  a.store.set('@suraksha.active.v2',JSON.stringify([source]));
  const receipt=(id,status,revision)=>({...payload(id),protocolVersion:3,revision:0,messageType:'SOS_ACK',location:null,
    userId:'suraksha-server',userName:'Suraksha server',originDeviceId:'suraksha-server',targetSosId:source.sosId,targetDeviceId:'device',
    receiptKind:'server',receiptRevision:revision,receiptMessageType:status==='cancelled'?'SOS_CANCEL':'SOS_ALERT',receiptStatus:status,receiptUserId:'owner'});
  c.setReceipt(receipt('receipt-accepted','accepted',0));
  await b.deliver(source);
  await c.deliver(b.ads.find(p=>p.sosId===source.sosId));
  assert.equal(c.sent[0].hopCount,2);assert.equal(b.sent.length,0);
  await b.deliver(c.ads.find(p=>p.receiptKind==='server'));
  await a.deliver(b.ads.find(p=>p.receiptKind==='server'));
  assert.equal(a.receipts[0].receiptStatus,'accepted');
  const cancel={...source,revision:1,messageType:'SOS_CANCEL',location:null,status:'CANCELLED'};
  c.setReceipt(receipt('receipt-cancelled','cancelled',1));
  await b.deliver(cancel);await c.deliver(b.ads.find(p=>p.messageType==='SOS_CANCEL'));
  await b.deliver(c.ads.find(p=>p.receiptStatus==='cancelled'));
  await a.deliver(b.ads.find(p=>p.receiptStatus==='cancelled'));
  assert.equal(a.receipts.at(-1).receiptStatus,'cancelled');
  assert.equal((await b.runtime.nearbyEvents()).length,0);assert.equal((await c.runtime.nearbyEvents()).length,0);
});

test('GPS failure and stale fixes preserve signed active SOS coordinates', async () => {
  const h=queueHarness(); await h.start(params);
  const original=(await h.service.activeSOS())[0].location;
  h.setFailLocation(true); await h.service.updateActiveLocations(undefined,true);
  assert.equal((await h.service.activeSOS())[0].location.capturedAt,original.capturedAt);
  await h.service.updateActiveLocations({...original,latitude:40,capturedAt:new Date(Date.parse(original.capturedAt)-1000).toISOString()},true);
  assert.equal((await h.service.activeSOS())[0].location.latitude,original.latitude);
  await h.service.updateActiveLocations({...original,latitude:41,accuracy:999},true);
  assert.equal((await h.service.activeSOS())[0].location.latitude,original.latitude);
});

test('duplicate longer relay path cannot exhaust the retained packet hop budget', async () => {
  const h=relayHarness(); const event={...payload('short-path'),protocolVersion:3,revision:0};
  await h.deliver(event);
  await h.deliver({...event,hopCount:14,relayChain:[{deviceId:'other',timestamp:event.timestamp}]});
  const stored=JSON.parse(h.store.get('@suraksha.relay.pending.v2')).find(p=>p.sosId===event.sosId);
  assert.equal(stored.hopCount,1);assert.equal(stored.uploadOnly,false);
  assert.equal((await h.runtime.nearbyEvents()).length,1);
});

test('four simulated phones retain multiple offline incidents and deliver cancellation before delayed alerts', async () => {
  const b=relayHarness({deviceId:'b'}),c=relayHarness({deviceId:'c'}),d=relayHarness({deviceId:'d'});
  const events=[{...payload('a-first'),protocolVersion:3,revision:0},{...payload('a-second'),protocolVersion:3,revision:0}];
  for(const source of events) {
    await b.deliver(source);
    await c.deliver(b.ads.find(p=>p.sosId===source.sosId));
    await d.deliver(c.ads.find(p=>p.sosId===source.sosId));
  }
  assert.equal(b.sent.length+c.sent.length+d.sent.length,0);
  assert.equal((await d.runtime.nearbyEvents()).length,2);
  const cancel={...events[0],revision:1,messageType:'SOS_CANCEL',status:'CANCELLED',location:null};
  await b.deliver(cancel);await c.deliver(b.ads.find(p=>p.messageType==='SOS_CANCEL'));
  await d.deliver(c.ads.find(p=>p.messageType==='SOS_CANCEL'));
  await d.deliver(events[0]); // A delayed original may never reactivate it.
  d.setOnline(true);await d.runtime.processMeshWork();
  assert.equal(d.sent[0].messageType,'SOS_CANCEL');
  assert.equal(d.sent.filter(p=>p.sosId==='a-first'&&p.messageType==='SOS_ALERT').length,0);
  assert.equal(d.sent.find(p=>p.sosId==='a-second').hopCount,3);
  assert.equal((await d.runtime.nearbyEvents())[0].sosId,'a-second');
  await d.runtime.processMeshWork();assert.equal(d.sent.length,2);
});

test('relay display preserves last location while forwarding the unmodified signed update', async () => {
  const h=relayHarness(); const first={...payload('location-retained'),protocolVersion:3,revision:0};
  await h.deliver(first);await h.deliver({...first,revision:1,location:null});
  assert.equal((await h.runtime.nearbyEvents())[0].location.capturedAt,first.location.capturedAt);
  const queued=JSON.parse(h.store.get('@suraksha.relay.pending.v2')).find(p=>p.sosId===first.sosId);
  assert.equal(queued.location,null);assert.equal(queued.revision,1);
});

test('location watch is removed after a fix and after a timeout with late registration', async () => {
  let removed=0;
  const base={getForegroundPermissionsAsync:async()=>({granted:true}),hasServicesEnabledAsync:async()=>true,Accuracy:{High:4},
    getLastKnownPositionAsync:async()=>null};
  const location=loader({'expo-location':{...base,watchPositionAsync:async(_options,onFix)=>{
    onFix({coords:{latitude:12,longitude:77,accuracy:8},timestamp:Date.now()});return {remove(){removed++;}};
  }}})('src/services/location.service.ts');
  assert.equal((await location.LocationService.getCurrentLocation(false)).latitude,12);
  await new Promise(r=>setImmediate(r));assert.equal(removed,1);
  let release;
  const late=new Promise(r=>{release=r;});
  const timeout=loader({'expo-location':{...base,watchPositionAsync:()=>late}},
    {setTimeout:(fn,ms)=>setTimeout(fn,ms===15000?1:ms)})('src/services/location.service.ts');
  await assert.rejects(timeout.LocationService.getCurrentLocation(false),/Unable to obtain/);
  release({remove(){removed++;}});await new Promise(r=>setImmediate(r));assert.equal(removed,2);
});

test('concurrent background tracking starts coalesce and cancellation stops the pending start', async () => {
  let starts=0,stops=0,enabled=false;
  const tracking=loader({'react-native':{Platform:{OS:'android'}},'expo-location':{
    Accuracy:{High:4},requestForegroundPermissionsAsync:async()=>({granted:true}),requestBackgroundPermissionsAsync:async()=>({granted:true}),
    hasStartedLocationUpdatesAsync:async()=>enabled,startLocationUpdatesAsync:async()=>{starts++;enabled=true;},
    stopLocationUpdatesAsync:async()=>{stops++;enabled=false;}
  }})('src/services/sos-tracking.service.ts');
  await Promise.all([tracking.startSOSTracking(),tracking.startSOSTracking(),tracking.stopSOSTracking()]);
  assert.equal(starts,1);assert.equal(stops,1);assert.equal(enabled,false);
});

test('401 refresh retries once with account credentials instead of stale compatibility token', async () => {
  const calls=[];let refreshes=0;
  const api=loader({'./session.service':{sessionToken:async(force)=>{if(force)refreshes++;return force?'fresh':'expired';}}},
    {fetch:async(_url,options)=>{calls.push(options.headers.get('Authorization'));return calls.length===1?
      new Response('{}',{status:401}):new Response(JSON.stringify({success:true,sos_id:'one'}));}})('src/services/sos-api.service.ts');
  api.SOSApiService.setAuthToken('stale');await api.SOSApiService.sendSOS(payload());
  assert.deepEqual(calls,['Bearer expired','Bearer fresh']);assert.equal(refreshes,1);
});


test('expired signing credentials cannot block local cancellation or authenticated online recovery', async () => {
  const h=queueHarness();const event=await h.start(params);h.setFailSigning(true);
  await h.service.cancelSOS(event.sosId,'owner');
  assert.equal((await h.service.activeSOS()).length,0);
  assert.equal(h.store.get('@suraksha_sos_queue'),'[]');
  const draft=JSON.parse(h.store.get('@suraksha.cancel.packets.v2'))[0];
  assert.equal(draft.messageType,'SOS_CANCEL');assert.equal(draft.originProof,undefined);
  h.setOnline(true);await h.service.retryPendingQueue();
  assert.equal(h.store.get('@suraksha_sos_cancellations'),'[]');
});

test('background GPS fix arriving during a pending lookup is retained after it finishes', async () => {
  const h=queueHarness();await h.start(params);
  let release,began;const blocked=new Promise(r=>{release=r;});const started=new Promise(r=>{began=r;});
  h.setBlockGPS(async()=>{began();await blocked;});
  const lookup=h.service.updateActiveLocations(undefined,true);await started;
  const fix={...payload().location,latitude:18,capturedAt:new Date(Date.now()+1000).toISOString()};
  const callback=h.service.updateActiveLocations(fix,true);release();
  await Promise.all([lookup,callback]);
  assert.equal((await h.service.activeSOS())[0].location.latitude,18);
});
