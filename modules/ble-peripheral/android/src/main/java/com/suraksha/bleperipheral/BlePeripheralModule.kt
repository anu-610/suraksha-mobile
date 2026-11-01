package com.suraksha.bleperipheral

import android.Manifest
import android.app.*
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.*
import android.os.*
import android.util.Base64
import androidx.core.app.NotificationCompat
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
            MeshRuntime.get(context).checkBluetooth()
            context.getSharedPreferences("suraksha-transport", Context.MODE_PRIVATE).edit().putBoolean("relay-enabled", true).commit()
            val intent = Intent(context, MeshForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
            MeshRuntime.get(context).also { it.setForeground(appContext.currentActivity != null); it.startScanning() }
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
        if (Build.VERSION.SDK_INT >= 29) startForeground(7310, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        else startForeground(7310, notification)
        handler.post(tick)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!relayEnabled()) { stopSelf(); return START_NOT_STICKY }
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
        MeshRuntime.engine?.stopScanning()
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
    private var rotationIndex = 0
    private val rotate = object : Runnable {
        override fun run() {
            synchronized(this@MeshEngine) {
                val now = System.currentTimeMillis()
                packets.entries.removeAll { expires(it.value) <= now }
                persistPackets()
                if (packets.isEmpty()) { stopAdvertising(); return }
                payload = packets.values.elementAt(rotationIndex++ % packets.size)
            }
            handler.postDelayed(this, 10000)
        }
    }
    private fun expires(bytes: ByteArray): Long {
        val objectData = org.json.JSONObject(String(bytes, Charsets.UTF_8))
        return java.time.Instant.parse(objectData.getString("timestamp")).toEpochMilli() + objectData.getLong("ttlSeconds") * 1000
    }
    private fun persistPackets() { prefs.edit().putString("adverts", JSONArray(packets.values.map { Base64.encodeToString(it, Base64.NO_WRAP) }).toString()).commit() }
    @Synchronized fun resumeAdvertisements() {
        if (advertising || starting) return
        val saved = JSONArray(prefs.getString("adverts", "[]"))
        for (index in 0 until saved.length()) {
            try {
                val bytes = Base64.decode(saved.getString(index), Base64.DEFAULT)
                if (expires(bytes) > System.currentTimeMillis()) packets[org.json.JSONObject(String(bytes, Charsets.UTF_8)).getString("sosId")] = bytes
            } catch (_: Exception) {}
        }
        if (packets.isNotEmpty()) { payload = packets.values.first(); beginAdvertising() }
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
    @Synchronized fun ensureRadio() {
        if (!adapter.isEnabled) {
            stopScanning()
            if (advertising || starting) {
                val saved = packets.toMap()
                stopAdvertising()
                packets.putAll(saved)
                persistPackets()
            }
            return
        }
        startScanning()
        resumeAdvertisements()
    }
    fun setForeground(value: Boolean) {
        if (foreground == value) return
        foreground = value
        if (scanning) {
            // Change duty cycle without dropping active GATT transfers.
            try { adapter.bluetoothLeScanner.stopScan(scanCallback); scanning = false; startScanning() }
            catch (error: Exception) { MeshRuntime.listener?.invoke("onError", mapOf("error" to (error.message ?: "Cannot restart scan"))) }
        }
    }
    @Synchronized fun startScanning() {
        scanWanted = true
        checkBluetooth()
        if (scanning) return
        adapter.bluetoothLeScanner.startScan(listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build()),
            ScanSettings.Builder().setScanMode(if (foreground) ScanSettings.SCAN_MODE_LOW_LATENCY else ScanSettings.SCAN_MODE_BALANCED).build(), scanCallback)
        scanning = true
    }
    fun stopScanning() {
        scanWanted = false
        try { adapter?.bluetoothLeScanner?.stopScan(scanCallback) } catch (_: SecurityException) {}
        scanning = false
        connections.values.forEach { try { it.disconnect(); it.close() } catch (_: Exception) {} }
        connections.clear()
    }
    @Synchronized fun advertise(base64: String, promise: Promise) {
        try {
            checkBluetooth()
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            check(bytes.isNotEmpty() && bytes.size <= MAX_BYTES) { "Packet must contain 1–16384 bytes" }
            if (pending != null) { promise.reject("BLE_BUSY", "Advertising is starting", null); return }
            val id = org.json.JSONObject(String(bytes, Charsets.UTF_8)).getString("sosId")
            check(expires(bytes) > System.currentTimeMillis()) { "SOS expired" }
            synchronized(this) {
                check(packets.size < 100 || packets.containsKey(id)) { "Relay advertising queue is full" }
                if (packets[id]?.contentEquals(bytes) != true) payload = bytes
                packets[id] = bytes
                persistPackets()
            }
            if (advertising) { promise.resolve(true); return }
            payload = bytes
            pending = promise
            beginAdvertising()
        } catch (error: Exception) { pending = null; promise.reject("BLE_ADV_ERROR", error.message, error); stopAdvertising() }
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
        handler.removeCallbacks(rotate)
        packets.clear(); persistPackets(); starting = false
        handler.removeCallbacks(advertTimeout)
        advertExpiry?.let { handler.removeCallbacks(it) }; advertExpiry = null
        pending?.reject("BLE_STOPPED", "Advertising stopped", null); pending = null
        try { adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertCallback) } catch (_: Exception) {}
        server?.close(); server = null; advertising = false
        cursors.clear(); snapshots.clear(); mtus.clear(); chunkSizes.clear()
    }
    private fun failAdvertising(message: String) {
        pending?.reject("BLE_ADV_ERROR", message, null); pending = null
        stopAdvertising()
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
            cursors.remove(device.address); snapshots.remove(device.address); mtus.remove(device.address); chunkSizes.remove(device.address)
        }
        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) { mtus[device.address] = mtu }
        override fun onCharacteristicReadRequest(device: BluetoothDevice, requestId: Int, offset: Int, characteristic: BluetoothGattCharacteristic) {
            if (offset != 0 || (characteristic.uuid != DATA && characteristic.uuid != FAST_DATA)) { server?.sendResponse(device,requestId,BluetoothGatt.GATT_INVALID_OFFSET,offset,null); return }
            if (snapshots.size >= 8 && !snapshots.containsKey(device.address)) { server?.sendResponse(device,requestId,BluetoothGatt.GATT_FAILURE,0,null); return }
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
            cursors[device.address] = seq + 1
        }
    }
    private val advertCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settings: AdvertiseSettings) { handler.removeCallbacks(advertTimeout); advertising=true; starting=false; pending?.resolve(true); pending=null; handler.removeCallbacks(rotate); handler.post(rotate) }
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
            handler.postDelayed({
                if (scanWanted && !scanning) try { startScanning() } catch (_: Exception) {}
            }, 6000)
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
                lastSeen[device.address] = System.currentTimeMillis()
                connections.remove(device.address, gatt); gatt.disconnect(); gatt.close()
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
}
