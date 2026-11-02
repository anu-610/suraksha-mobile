package com.suraksha.bleperipheral

import android.Manifest
import android.app.*
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.*
import android.os.*
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import org.json.JSONArray
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Native transport remains owned by the foreground service, not a React screen. */
internal object MeshRuntime {
    var engine: MeshEngine? = null
    var listener: ((String, Map<String, Any>) -> Unit)? = null
    fun get(context: Context): MeshEngine = synchronized(this) {
        engine ?: MeshEngine(context.applicationContext).also { engine = it }
    }
}

class BlePeripheralModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("BlePeripheral")
        Events("onSOSReceived", "onCancelReceived", "onDeviceDiscovered", "onError")
        OnCreate { MeshRuntime.listener = { name, body -> sendEvent(name, body) } }
        OnActivityEntersForeground { MeshRuntime.engine?.setForeground(true) }
        OnActivityEntersBackground { MeshRuntime.engine?.setForeground(false) }
        OnDestroy { MeshRuntime.listener = null } // The service deliberately survives React teardown.
        AsyncFunction("initialize") { MeshRuntime.get(requireContext()).checkBluetooth(); true }
        AsyncFunction("startAdvertising") { payload: String, promise: Promise ->
            MeshRuntime.get(requireContext()).advertise(payload, promise)
        }
        AsyncFunction("removeAdvertisement") { id: String -> MeshRuntime.get(requireContext()).removeAdvertisement(id) }
        AsyncFunction("stopAdvertising") { MeshRuntime.get(requireContext()).stopAdvertising(); true }
        AsyncFunction("startScanning") {
            val context = requireContext()
            // Scan first: a missing Nearby devices permission fails here with a clear
            // message instead of inside the foreground service.
            MeshRuntime.get(context).also { it.setForeground(appContext.currentActivity != null); it.startScanning() }
            context.getSharedPreferences("suraksha-transport", Context.MODE_PRIVATE).edit().putBoolean("relay-enabled", true).commit()
            val intent = Intent(context, MeshForegroundService::class.java)
            try { if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent) }
            catch (error: Exception) {
                // Android 12+ refuses this from the background. Scanning still runs in
                // process; the next app launch starts the service.
                MeshRuntime.listener?.invoke("onError", mapOf("error" to "Background relay starts next time Suraksha is opened"))
            }
            true
        }
        AsyncFunction("stopScanning") {
            val context = requireContext()
            context.getSharedPreferences("suraksha-transport", Context.MODE_PRIVATE).edit().putBoolean("relay-enabled", false).commit()
            context.stopService(Intent(context, MeshForegroundService::class.java))
            MeshRuntime.get(context).stopScanning()
            true
        }
        AsyncFunction("broadcastCancellation") { _: String -> false }
        AsyncFunction("getInbox") { MeshRuntime.get(requireContext()).inbox() }
        AsyncFunction("acknowledgeInbox") { packet: String -> MeshRuntime.get(requireContext()).acknowledge(packet) }
        Function("isSupported") {
            (requireContext().getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter?.isMultipleAdvertisementSupported == true
        }
    }
    private fun requireContext(): Context = appContext.reactContext ?: throw IllegalStateException("React context unavailable")
}

/** Android 14+ connectedDevice foreground service. Start only from explicit foreground opt-in. */
class MeshForegroundService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var started = false
    private val tick = object : Runnable {
        override fun run() {
            if (!relayEnabled()) { stopSelf(); return }
            // Native scanning has no JS timer dependency. Recover radio toggles and
            // transient scan failures even when no React screen is mounted.
            try { MeshRuntime.get(this@MeshForegroundService).ensureRadio() }
            catch (_: Exception) { /* Permission/radio state may recover on the next tick. */ }
            try { startService(Intent(this@MeshForegroundService, MeshRelayTaskService::class.java)) }
            catch (_: Exception) { /* Durable inbox is retried on next tick or app launch. */ }
            handler.postDelayed(this, 15000)
        }
    }
    private fun relayEnabled() = getSharedPreferences("suraksha-transport", Context.MODE_PRIVATE).getBoolean("relay-enabled", false)
    override fun onCreate() {
        super.onCreate()
        val notifications = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) notifications.createNotificationChannel(NotificationChannel("suraksha-relay", "Nearby emergency relay", NotificationManager.IMPORTANCE_LOW))
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val notification = NotificationCompat.Builder(this, "suraksha-relay")
            .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("Suraksha nearby relay is active")
            .setContentText("Scanning for emergency alerts. Open Suraksha to stop.").setOngoing(true)
            .setContentIntent(launch?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }).build()
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(7310, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
            else startForeground(7310, notification)
        } catch (error: Exception) {
            // Android 14+ throws for a connectedDevice service without Bluetooth
            // permission (e.g. revoked, then a sticky restart). Stop, don't crash-loop.
            MeshRuntime.listener?.invoke("onError", mapOf("error" to "Nearby relay stopped. Allow Nearby devices permission and enable relay again."))
            stopSelf(); return
        }
        started = true
        handler.post(tick)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!started || !relayEnabled()) { stopSelf(); return START_NOT_STICKY }
        try { MeshRuntime.get(this).ensureRadio() }
        catch (error: Exception) {
            MeshRuntime.listener?.invoke("onError", mapOf("error" to (error.message ?: "Bluetooth unavailable")))
            // Keep the user-enabled service alive while Bluetooth is temporarily off.
        }
        return START_STICKY
    }
    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiping the activity away must not stop the opt-in foreground service.
        MeshRuntime.engine?.setForeground(false)
        super.onTaskRemoved(rootIntent)
    }
    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        // A service that never got foreground must not kill the in-app scan.
        if (started) MeshRuntime.engine?.stopScanning()
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
}

/** Wakes JS for verified notifications, API forwarding and durable retry processing. */
class MeshRelayTaskService : HeadlessJsTaskService() {
    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
        HeadlessJsTaskConfig("SurakshaRelay", Arguments.createMap(), 120000, true)
}

internal class MeshEngine(private val context: Context) {
    companion object {
        val SERVICE: UUID = UUID.fromString("8fc9a2e0-1b2a-4c3d-9e5f-0a1b2c3d4e5f")
        val DATA: UUID = UUID.fromString("8fc9a2e1-1b2a-4c3d-9e5f-0a1b2c3d4e5f")
        val FAST_DATA: UUID = UUID.fromString("8fc9a2e3-1b2a-4c3d-9e5f-0a1b2c3d4e5f")
        const val MAX_BYTES = 16384
    }
    private val adapter get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter ?: throw IllegalStateException("Bluetooth unsupported")
    private val handler = Handler(Looper.getMainLooper())
    private val prefs = context.getSharedPreferences("suraksha-transport", Context.MODE_PRIVATE)
    private var foreground = false
    private var scanWanted = false
    private var scanning = false
    private var advertising = false
    private var server: BluetoothGattServer? = null
    private var payload = ByteArray(0)
    private var pending: Promise? = null
    private var starting = false
    private val packets = linkedMapOf<String, ByteArray>()
    private val versions = linkedMapOf<String, ByteArray>()
    private var rotationIndex = 0
    private var retryDelay = 1000L
    private val retryRadio = Runnable { synchronized(this) { try { resumeAdvertisements() } catch (error: Exception) { failAdvertising(error.message ?: "Bluetooth restart failed") } } }
    private fun scheduleRadioRetry() {
        if (packets.isEmpty()) return
        handler.removeCallbacks(retryRadio)
        handler.postDelayed(retryRadio, retryDelay)
        retryDelay = minOf(30000L, retryDelay * 2)
    }
    private fun objectData(bytes: ByteArray) = org.json.JSONObject(String(bytes, Charsets.UTF_8))
    private fun version(bytes: ByteArray): PacketVersion {
        val p = objectData(bytes)
        return PacketVersion(p.getString("userId"), p.getString("messageType"), p.optLong("revision", 0),
            java.time.Instant.parse(p.getString("timestamp")).toEpochMilli(), p.optString("helperState", ""), p.optInt("hopCount", 0))
    }
    private fun priority(bytes: ByteArray): Int {
        val p = objectData(bytes)
        return PacketPolicy.priority(p.getString("messageType"), p.optString("helperState", ""), p.optBoolean("helperRequested", false))
    }
    private fun nextPacket(): ByteArray {
        val all = packets.values.toList()
        // Every other slot favors controls; round robin slots keep alerts moving.
        val index = rotationIndex++ and Int.MAX_VALUE
        val controls = all.filter { priority(it) < 4 }.sortedBy { priority(it) }
        val urgent = controls.filter { priority(it) == priority(controls.first()) }
        return if (index % 2 == 0 && urgent.isNotEmpty()) urgent[(index / 2) % urgent.size] else all[(index / 2) % all.size]
    }
    private val rotate = object : Runnable {
        override fun run() {
            synchronized(this@MeshEngine) {
                val now = System.currentTimeMillis()
                packets.entries.removeAll { expires(it.value) <= now }
                try { persistPackets() } catch (error: Exception) {
                    MeshRuntime.listener?.invoke("onError", mapOf("error" to (error.message ?: "Cannot persist BLE queue")))
                }
                if (packets.isEmpty()) { stopAdvertising(); return }
                payload = nextPacket()
            }
            handler.postDelayed(this, 10000)
        }
    }
    private fun expires(bytes: ByteArray): Long {
        val objectData = org.json.JSONObject(String(bytes, Charsets.UTF_8))
        return java.time.Instant.parse(objectData.getString("timestamp")).toEpochMilli() + objectData.getLong("ttlSeconds") * 1000
    }
    private fun persistPackets() {
        versions.entries.removeAll { expires(it.value) + 300000 <= System.currentTimeMillis() }
        check(prefs.edit().putString("adverts", JSONArray(packets.values.map { Base64.encodeToString(it, Base64.NO_WRAP) }).toString())
            .putString("versions", JSONArray(versions.values.map { Base64.encodeToString(it, Base64.NO_WRAP) }).toString()).commit()) { "Cannot persist BLE queue" }
    }
    private fun restorePackets() {
        val floors = JSONArray(prefs.getString("versions", "[]"))
        for (index in 0 until floors.length()) {
            try {
                val bytes = Base64.decode(floors.getString(index), Base64.DEFAULT)
                if (expires(bytes) + 300000 > System.currentTimeMillis()) versions[objectData(bytes).getString("sosId")] = bytes
            } catch (_: Exception) {}
        }
        val saved = JSONArray(prefs.getString("adverts", "[]"))
        for (index in 0 until saved.length()) {
            try {
                val bytes = Base64.decode(saved.getString(index), Base64.DEFAULT)
                if (expires(bytes) > System.currentTimeMillis()) packets[org.json.JSONObject(String(bytes, Charsets.UTF_8)).getString("sosId")] = bytes
            } catch (_: Exception) {}
        }
    }
    init { restorePackets() }
    @Synchronized fun resumeAdvertisements() {
        if (advertising || starting) return
        checkBluetooth()
        packets.entries.removeAll { expires(it.value) <= System.currentTimeMillis() }
        if (packets.isNotEmpty()) {
            payload = packets.values.minByOrNull { priority(it) }!!
            try { beginAdvertising() } catch (error: Exception) { stopRadio(); throw error }
        }
    }
    @Synchronized fun removeAdvertisement(id: String) {
        packets.remove(id); persistPackets()
        if (packets.isEmpty()) stopAdvertising()
        else payload = packets.values.first()
    }
    private val connections = ConcurrentHashMap<String, BluetoothGatt>()
    private val cursors = ConcurrentHashMap<String, Int>()
    private val snapshots = ConcurrentHashMap<String, ByteArray>()
    private val mtus = ConcurrentHashMap<String, Int>()
    private val chunkSizes = ConcurrentHashMap<String, Int>()
    private val lastSeen = ConcurrentHashMap<String, Long>()
    private val lastReads = ConcurrentHashMap<String, Long>()
    private var advertExpiry: Runnable? = null
    private val advertTimeout = Runnable { failAdvertising("Advertising timed out") }
    fun checkBluetooth() { check(adapter?.isEnabled == true) { "Enable Bluetooth to use nearby relay" } }
    @Synchronized fun inbox(): List<String> {
        val array = JSONArray(prefs.getString("inbox", "[]"))
        return (0 until array.length()).map { array.getString(it) }
    }
    @Synchronized fun acknowledge(packet: String) { prefs.edit().putString("inbox", JSONArray(inbox().filter { it != packet }).toString()).commit() }
    @Synchronized private fun received(bytes: ByteArray) {
        val packet = Base64.encodeToString(bytes, Base64.NO_WRAP)
        val existing = inbox()
        if (!existing.contains(packet)) {
            // Bound attacker-controlled storage. Never evict already accepted inbox items.
            if (existing.size >= 100) return
            if (!prefs.edit().putString("inbox", JSONArray(existing + packet).toString()).commit()) return
        }
        MeshRuntime.listener?.invoke("onSOSReceived", mapOf("payloadBase64" to packet, "deviceId" to "native"))
        try { context.startService(Intent(context, MeshRelayTaskService::class.java)) } catch (_: Exception) {}
    }
    // Android kills the scan and GATT server with the radio and sends no scan or
    // advertise callback, so `scanning`/`advertising` used to stay true and a
    // quick off/on toggle left the phone deaf until the app was restarted.
    // Keep scanWanted and the packet queue; only the radio state is reset.
    @Synchronized private fun radioOff() {
        scanning = false
        handler.removeCallbacks(scanRetry); handler.removeCallbacks(dutyChange)
        connections.values.forEach { try { it.close() } catch (_: Exception) {} }
        connections.clear()
        if (advertising || starting) stopRadio()
    }
    @Synchronized private fun radioOn() {
        try {
            if (scanWanted) startScanning()
            resumeAdvertisements()
        } catch (error: Exception) {
            MeshRuntime.listener?.invoke("onError", mapOf("error" to (error.message ?: "Bluetooth restart failed")))
            scheduleRadioRetry()
        }
    }
    private val bluetoothState = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
                BluetoothAdapter.STATE_TURNING_OFF, BluetoothAdapter.STATE_OFF -> radioOff()
                // LE is not always usable the instant the adapter reports ON.
                BluetoothAdapter.STATE_ON -> handler.postDelayed({ radioOn() }, 1000)
            }
        }
    }
    @Synchronized fun ensureRadio() {
        if (!adapter.isEnabled) { radioOff(); return }
        // Some phones quietly drop a scan that has run for ~30 min to
        // opportunistic mode (no results). Refresh it well before that.
        if (scanning && System.currentTimeMillis() - scanStartedAt > 20 * 60000L) restartScan()
        startScanning()
        resumeAdvertisements()
    }
    private val scanStarts = ArrayDeque<Long>()
    private var scanStartedAt = 0L
    private var scanForeground = false
    private val scanRetry = Runnable { synchronized(this) { if (scanWanted && !scanning) try { startScanning() } catch (_: Exception) {} } }
    // Debounced so quick app switches don't burn Android's scan-start budget.
    private val dutyChange = Runnable { synchronized(this) { if (scanning && scanForeground != foreground) restartScan() } }
    @Synchronized fun setForeground(value: Boolean) {
        if (foreground == value) return
        foreground = value
        handler.removeCallbacks(dutyChange)
        handler.postDelayed(dutyChange, 3000)
    }
    @Synchronized private fun restartScan() {
        // Change duty cycle without dropping active GATT transfers.
        try { adapter.bluetoothLeScanner?.stopScan(scanCallback) } catch (_: Exception) {}
        scanning = false
        try { startScanning() }
        catch (error: Exception) { MeshRuntime.listener?.invoke("onError", mapOf("error" to (error.message ?: "Cannot restart scan"))) }
    }
    @Synchronized fun startScanning() {
        scanWanted = true
        checkBluetooth()
        if (scanning) return
        val now = System.currentTimeMillis()
        val wait = PacketPolicy.scanStartDelay(scanStarts.toList(), now)
        // Starting anyway would look fine here but Android may never deliver results.
        if (wait > 0) { handler.removeCallbacks(scanRetry); handler.postDelayed(scanRetry, wait); return }
        val scanner = adapter.bluetoothLeScanner ?: throw IllegalStateException("Enable Bluetooth to use nearby relay")
        scanner.startScan(listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build()),
            ScanSettings.Builder().setScanMode(if (foreground) ScanSettings.SCAN_MODE_LOW_LATENCY else ScanSettings.SCAN_MODE_BALANCED).build(), scanCallback)
        scanStarts.addLast(now); while (scanStarts.size > 5) scanStarts.removeFirst()
        scanStartedAt = now; scanForeground = foreground
        scanning = true
    }
    @Synchronized fun stopScanning() {
        scanWanted = false
        handler.removeCallbacks(scanRetry); handler.removeCallbacks(dutyChange)
        try { adapter?.bluetoothLeScanner?.stopScan(scanCallback) } catch (_: SecurityException) {}
        scanning = false
        connections.values.forEach { try { it.disconnect(); it.close() } catch (_: Exception) {} }
        connections.clear()
    }
    @Synchronized fun advertise(base64: String, promise: Promise) {
        try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            check(bytes.isNotEmpty() && bytes.size <= MAX_BYTES) { "Packet must contain 1–16384 bytes" }
            val data = objectData(bytes)
            val id = data.getString("sosId")
            check(expires(bytes) > System.currentTimeMillis()) { "SOS expired" }
            synchronized(this) {
                val previous = versions[id] ?: packets[id]
                if (!PacketPolicy.canReplace(previous?.let { version(it) }, version(bytes))) { promise.resolve(true); return }
                check(PacketPolicy.hasCapacity(packets.size, packets.containsKey(id), priority(bytes))) { "Relay advertising queue is full" }
                // Routine durable retries must not reset round-robin rotation.
                // Only a genuinely urgent packet or the current packet's update preempts.
                if (PacketPolicy.shouldPreempt(if (payload.isEmpty()) null else objectData(payload).getString("sosId"),
                        id, if (payload.isEmpty()) Int.MAX_VALUE else priority(payload), priority(bytes),
                        packets[id]?.contentEquals(bytes) != true)) payload = bytes
                packets[id] = bytes
                versions[id] = bytes
                // A verified cancellation/request change also retires old consent snapshots.
                if (data.getString("messageType") in listOf("SOS_CANCEL", "SOS_ALERT")) {
                    packets.entries.removeAll { (_, stored) ->
                        val p = objectData(stored)
                        p.optString("targetSosId") == id && p.optString("messageType") == "SOS_HELPER" &&
                            (data.getString("messageType") == "SOS_CANCEL" || !data.optBoolean("helperRequested") || p.optString("helperRequestId") != data.optString("helperRequestId"))
                    }
                }
                persistPackets()
            }
            checkBluetooth()
            if (advertising || starting) { promise.resolve(true); return }
            payload = packets.values.minByOrNull { priority(it) }!!
            pending = promise
            try { beginAdvertising() } catch (error: Exception) { pending = null; stopRadio(); throw error }
        } catch (error: Exception) { promise.reject("BLE_ADV_ERROR", error.message, error); scheduleRadioRetry() }
    }
    private fun beginAdvertising() {
        starting = true
        server = (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).openGattServer(context, serverCallback)
        check(server != null) { "GATT server unavailable" }
        val service = BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(BluetoothGattCharacteristic(DATA, BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ))
        // Separate characteristic preserves interoperability with old 20-byte readers.
        service.addCharacteristic(BluetoothGattCharacteristic(FAST_DATA, BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ))
        check(server!!.addService(service)) { "Cannot publish GATT service" }
        handler.postDelayed(advertTimeout, 10000)
    }
    @Synchronized fun stopAdvertising() {
        packets.clear(); persistPackets()
        handler.removeCallbacks(retryRadio)
        stopRadio()
    }
    @Synchronized private fun stopRadio() {
        handler.removeCallbacks(rotate)
        starting = false
        handler.removeCallbacks(advertTimeout)
        advertExpiry?.let { handler.removeCallbacks(it) }; advertExpiry = null
        pending?.reject("BLE_STOPPED", "Advertising stopped", null); pending = null
        try { adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertCallback) } catch (_: Exception) {}
        server?.close(); server = null; advertising = false
        cursors.clear(); snapshots.clear(); mtus.clear(); chunkSizes.clear(); lastReads.clear()
    }
    private fun failAdvertising(message: String) {
        pending?.reject("BLE_ADV_ERROR", message, null); pending = null
        stopRadio()
        scheduleRadioRetry()
        MeshRuntime.listener?.invoke("onError", mapOf("error" to message))
    }
    private val serverCallback = object : BluetoothGattServerCallback() {
        override fun onServiceAdded(status: Int, service: BluetoothGattService) {
            if (!starting) return
            if (status != BluetoothGatt.GATT_SUCCESS) { failAdvertising("Cannot publish GATT service"); return }
            val settings = AdvertiseSettings.Builder().setConnectable(true).setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY).build()
            val data = AdvertiseData.Builder().addServiceUuid(ParcelUuid(SERVICE)).setIncludeDeviceName(false).build()
            adapter.bluetoothLeAdvertiser?.startAdvertising(settings, data, advertCallback) ?: failAdvertising("Peripheral mode unsupported")
        }
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, state: Int) {
            endTransfer(device.address); mtus.remove(device.address)
        }
        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) { mtus[device.address] = mtu }
        override fun onCharacteristicReadRequest(device: BluetoothDevice, requestId: Int, offset: Int, characteristic: BluetoothGattCharacteristic) {
            if (offset != 0 || (characteristic.uuid != DATA && characteristic.uuid != FAST_DATA)) { server?.sendResponse(device,requestId,BluetoothGatt.GATT_INVALID_OFFSET,offset,null); return }
            val now = System.currentTimeMillis()
            // Two phones share one LE link, so it can outlive a reader's GATT
            // connection. A reconnecting reader starts at frame 0; so must we.
            lastReads.keys.filter { !PacketPolicy.transferIsLive(lastReads[it], now) }.forEach { endTransfer(it) }
            if (!PacketPolicy.transferIsLive(lastReads[device.address], now)) endTransfer(device.address)
            if (snapshots.size >= 8 && !snapshots.containsKey(device.address)) { server?.sendResponse(device,requestId,BluetoothGatt.GATT_FAILURE,0,null); return }
            lastReads[device.address] = now
            val snapshot = snapshots.getOrPut(device.address) { payload.copyOf() }
            val seq = cursors[device.address] ?: 0
            val chunkSize = chunkSizes.getOrPut(device.address) {
                if (characteristic.uuid == FAST_DATA) minOf(180, maxOf(12, (mtus[device.address] ?: 23) - 11)) else 12
            }
            val total = (snapshot.size + chunkSize - 1) / chunkSize
            if (total == 0 || seq >= total) { server?.sendResponse(device,requestId,BluetoothGatt.GATT_FAILURE,0,null); return }
            val chunk = snapshot.copyOfRange(seq * chunkSize, minOf(snapshot.size, (seq+1)*chunkSize))
            // Legacy DATA remains 20 bytes. FAST_DATA fits the negotiated ATT MTU.
            // Freeze chunk size per connection so sequence offsets stay consistent.
            val frame = byteArrayOf(83,75,2,(seq shr 8).toByte(),seq.toByte(),(total shr 8).toByte(),total.toByte(),chunk.size.toByte()) + chunk
            server?.sendResponse(device,requestId,BluetoothGatt.GATT_SUCCESS,0,frame)
            if (seq + 1 >= total) endTransfer(device.address) else cursors[device.address] = seq + 1
        }
    }
    private fun endTransfer(address: String) {
        cursors.remove(address); snapshots.remove(address); chunkSizes.remove(address); lastReads.remove(address)
    }
    private val advertCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settings: AdvertiseSettings) { handler.removeCallbacks(advertTimeout); handler.removeCallbacks(retryRadio); retryDelay=1000L; advertising=true; starting=false; pending?.resolve(true); pending=null; handler.removeCallbacks(rotate); handler.postDelayed(rotate, 10000) }
        override fun onStartFailure(code: Int) { failAdvertising("Advertising failed: $code") }
    }
    private val scanCallback = object : ScanCallback() {
        override fun onScanFailed(code: Int) {
            // Android reports ALREADY_STARTED when the foreground service and
            // React startup race to start the same scanner. The existing scan
            // remains active, so treat this as active instead of retry-looping.
            if (code == ScanCallback.SCAN_FAILED_ALREADY_STARTED) {
                scanning = true
                return
            }
            scanning = false
            val reason = when (code) {
                ScanCallback.SCAN_FAILED_APPLICATION_REGISTRATION_FAILED -> "Android could not register the Bluetooth scan"
                ScanCallback.SCAN_FAILED_INTERNAL_ERROR -> "Android Bluetooth scanner reported an internal error"
                ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED -> "Bluetooth scanning is unsupported on this device"
                ScanCallback.SCAN_FAILED_OUT_OF_HARDWARE_RESOURCES -> "Bluetooth scan resources are temporarily unavailable"
                ScanCallback.SCAN_FAILED_SCANNING_TOO_FREQUENTLY -> "Too many Bluetooth scan restarts; retrying shortly"
                else -> "Bluetooth scanning interrupted (code $code); retrying shortly"
            }
            MeshRuntime.listener?.invoke("onError", mapOf("error" to reason))
            handler.removeCallbacks(scanRetry)
            handler.postDelayed(scanRetry, 6000)
        }
        override fun onScanResult(type: Int, result: ScanResult) {
            val device = result.device
            val now = System.currentTimeMillis()
            if (connections.size >= 4 || connections.containsKey(device.address) || now - (lastSeen[device.address] ?: 0) < 3000) return
            if (lastSeen.size > 1000) lastSeen.clear()
            lastSeen[device.address] = now
            connect(device)
        }
    }
    private fun connect(device: BluetoothDevice) {
        val bytes = ByteArrayOutputStream()
        var expected = 0
        var count = -1
        var lastProgress = System.currentTimeMillis()
        var discoveryStarted = false
        var finished = false
        val gatt = device.connectGatt(context, false, object : BluetoothGattCallback() {
            @Synchronized fun finish(gatt: BluetoothGatt) {
                if (finished) return
                finished = true
                // Random extra cooldown so two phones reading each other drift apart
                // instead of colliding on every retry.
                lastSeen[device.address] = System.currentTimeMillis() + (Math.random() * 2000).toLong()
                closeWhenPeerDone(device, gatt, System.currentTimeMillis())
            }
            @Synchronized fun discover(gatt: BluetoothGatt) {
                if (finished || discoveryStarted) return
                discoveryStarted = true
                if (!gatt.discoverServices()) finish(gatt)
            }
            override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) { discover(gatt) }
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, state: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS || state == BluetoothProfile.STATE_DISCONNECTED) finish(gatt)
                else if (state == BluetoothProfile.STATE_CONNECTED) {
                    gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                    if (!gatt.requestMtu(247)) discover(gatt)
                    else handler.postDelayed({ discover(gatt) }, 1500)
                }
            }
            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                val char = gatt.getService(SERVICE)?.let { it.getCharacteristic(FAST_DATA) ?: it.getCharacteristic(DATA) }
                if (status != BluetoothGatt.GATT_SUCCESS || char == null || !gatt.readCharacteristic(char)) finish(gatt)
            }
            @Deprecated("Compatibility callback for Android < 33")
            override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
                consume(gatt, characteristic, characteristic.value ?: ByteArray(0), status)
            }
            override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
                consume(gatt, characteristic, value, status)
            }
            fun consume(gatt: BluetoothGatt, char: BluetoothGattCharacteristic, frame: ByteArray, status: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS || frame.size < 8 || frame[0].toInt()!=83 || frame[1].toInt()!=75 || frame[2].toInt()!=2) { finish(gatt); return }
                val seq = ((frame[3].toInt() and 255) shl 8) or (frame[4].toInt() and 255)
                val total = ((frame[5].toInt() and 255) shl 8) or (frame[6].toInt() and 255)
                val size = frame[7].toInt() and 255
                if (seq != expected || total < 1 || total > 1366 || (count != -1 && count != total) || size !in 1..(if (char.uuid == FAST_DATA) 180 else 12) || frame.size != 8+size || bytes.size()+size > MAX_BYTES) { finish(gatt); return }
                lastProgress = System.currentTimeMillis()
                count = total; expected++
                bytes.write(frame,8,size)
                if (expected == total) { received(bytes.toByteArray()); finish(gatt) }
                else if (!gatt.readCharacteristic(char)) finish(gatt)
            }
        }, BluetoothDevice.TRANSPORT_LE)
        if (gatt != null) {
            connections[device.address]=gatt
            val idleTimeout = object : Runnable {
                override fun run() {
                    if (connections[device.address] !== gatt) return
                    if (System.currentTimeMillis() - lastProgress < 15000) { handler.postDelayed(this, 5000); return }
                    if (connections.remove(device.address, gatt)) {
                        finished = true
                        lastSeen[device.address] = System.currentTimeMillis()
                        gatt.disconnect(); gatt.close()
                    }
                }
            }
            handler.postDelayed(idleTimeout, 15000)
        }
    }
    // Both phones share one LE link. Closing our client drops it, which cut the
    // peer off mid-read of our (often larger) packet; with matching retry timing
    // that could repeat on every attempt. Wait up to 10 s for the peer to finish.
    private fun closeWhenPeerDone(device: BluetoothDevice, gatt: BluetoothGatt, since: Long) {
        val now = System.currentTimeMillis()
        if (PacketPolicy.transferIsLive(lastReads[device.address], now) && now - since < 10000) {
            handler.postDelayed({ closeWhenPeerDone(device, gatt, since) }, 300); return
        }
        if (connections.remove(device.address, gatt)) try { gatt.disconnect(); gatt.close() } catch (_: Exception) {}
    }
    init {
        // Last, so every field the receiver touches is already initialised.
        ContextCompat.registerReceiver(context, bluetoothState, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
    }
}
