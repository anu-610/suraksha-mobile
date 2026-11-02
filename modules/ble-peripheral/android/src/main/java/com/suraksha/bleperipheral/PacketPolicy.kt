package com.suraksha.bleperipheral

/** Pure policy: radio failures never decide whether an accepted packet is deleted. */
internal data class PacketVersion(val owner: String, val type: String, val revision: Long,
    val timestamp: Long, val helperState: String = "", val hops: Int = 0)

internal object PacketPolicy {
    fun canReplace(old: PacketVersion?, next: PacketVersion): Boolean {
        if (old == null) return true
        if (old.owner != next.owner) return false
        if (old.type == "SOS_CANCEL" && next.type != "SOS_CANCEL") return false
        if (next.type == "SOS_CANCEL" && old.type != "SOS_CANCEL") return true
        if (old.helperState == "withdrawn" && next.type == "SOS_HELPER" && next.helperState != "withdrawn") return false
        return next.revision > old.revision || (next.revision == old.revision &&
            (next.timestamp > old.timestamp || next.timestamp == old.timestamp && next.hops <= old.hops))
    }
    fun shouldPreempt(currentId: String?, nextId: String, currentPriority: Int, nextPriority: Int,
                      changed: Boolean): Boolean = changed && (currentId == null || currentId == nextId || nextPriority < currentPriority)
    fun priority(type: String, helperState: String, requested: Boolean): Int = when {
        type == "SOS_CANCEL" -> 0
        helperState == "withdrawn" -> 1
        type == "SOS_ACK" -> 2
        type == "SOS_HELPER" || requested -> 3
        else -> 4
    }
    fun hasCapacity(size: Int, existing: Boolean, priority: Int): Boolean = existing || size < if (priority < 4) 132 else 100

    // Android allows 5 scan starts per 30 s per app. Past that, older versions
    // drop the scan without any callback, so we stay one below and wait instead.
    const val SCAN_START_LIMIT = 4
    const val SCAN_START_WINDOW_MS = 30000L
    fun scanStartDelay(recentStarts: List<Long>, now: Long): Long {
        val inWindow = recentStarts.filter { now - it < SCAN_START_WINDOW_MS }.sorted()
        if (inWindow.size < SCAN_START_LIMIT) return 0
        return inWindow[inWindow.size - SCAN_START_LIMIT] + SCAN_START_WINDOW_MS - now + 500
    }

    // Reads inside one GATT transfer come back to back. A longer gap means the
    // reader reconnected and expects frame 0 again, even if the LE link (and so
    // our per-device cursor) survived.
    const val TRANSFER_GAP_MS = 2000L
    fun transferIsLive(lastRead: Long?, now: Long): Boolean = lastRead != null && now - lastRead <= TRANSFER_GAP_MS

    // Which packet a reader gets next. `hashes` are queued packets in priority
    // order, `seen` what this reader already read. Unread packets go first, so a
    // new SOS reaches a phone on its next read even while an old cancellation
    // keeps advertising for its whole TTL. When all are read, a new round starts.
    fun nextForReader(hashes: List<Int>, seen: MutableSet<Int>): Int {
        if (hashes.isEmpty()) return -1
        seen.retainAll(hashes.toSet())
        val fresh = hashes.indexOfFirst { it !in seen }
        if (fresh >= 0) return fresh
        seen.clear()
        return 0
    }
}
