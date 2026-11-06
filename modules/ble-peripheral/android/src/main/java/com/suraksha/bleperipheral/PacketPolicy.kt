package com.suraksha.bleperipheral

/** Pure policy: radio failures never decide whether an accepted packet is deleted. */
internal data class PacketVersion(val owner: String, val type: String, val revision: Long,
    val timestamp: Long, val helperState: String = "", val hops: Int = 0)

/** What the queue cleanup needs from one packet, parsed once. */
internal data class PacketMeta(val id: String, val type: String, val timestamp: Long, val hops: Int = 0,
    val target: String = "", val origin: String = "", val receiptKind: String = "",
    val receiptType: String = "", val receiptRevision: Long = 0)

internal object PacketPolicy {
    // Cancels and receipts only confirm something that already happened. They
    // used to stay on air for the whole 1 h TTL, so every test SOS + cancel left
    // a pile behind (one receipt per location update per phone) that a new SOS
    // had to wait behind, or that filled the queue so the new SOS was refused.
    const val DONE_ON_AIR_MS = 15 * 60000L
    fun onAirUntil(type: String, timestamp: Long, ttlExpiry: Long): Long =
        if (type == "SOS_CANCEL" || type == "SOS_ACK") minOf(ttlExpiry, timestamp + DONE_ON_AIR_MS) else ttlExpiry

    // Order a reader gets packets in: newest first, receipts after everything else.
    val serveOrder: Comparator<PacketMeta> =
        compareBy<PacketMeta> { if (it.type == "SOS_ACK") 1 else 0 }.thenByDescending { it.timestamp }

    // One receipt per (SOS, kind, sender) is enough: the newest one.
    private fun sameReceiptSlot(a: PacketMeta, b: PacketMeta) = a.type == "SOS_ACK" && b.type == "SOS_ACK" &&
        a.target == b.target && a.receiptKind == b.receiptKind && a.origin == b.origin
    private fun receiptCompare(a: PacketMeta, b: PacketMeta): Int =
        compareValuesBy(a, b, { if (it.receiptType == "SOS_CANCEL") 1 else 0 }, { it.receiptRevision }, { it.timestamp })

    /** Queued packets that `added` makes useless: older receipts of the same slot, alert receipts of a cancelled SOS. */
    fun staleAfter(added: PacketMeta, queued: Collection<PacketMeta>): List<String> = queued.filter { it.id != added.id && (
        sameReceiptSlot(added, it) && receiptCompare(added, it) >= 0 ||
        added.type == "SOS_CANCEL" && it.type == "SOS_ACK" && it.target == added.id && it.receiptType == "SOS_ALERT") }.map { it.id }

    /** `added` is already useless: a newer receipt of its slot, or the cancel of its SOS, is queued. */
    fun isStale(added: PacketMeta, queued: Collection<PacketMeta>): Boolean = added.type == "SOS_ACK" && queued.any { it.id != added.id && (
        sameReceiptSlot(added, it) && receiptCompare(it, added) > 0 ||
        added.receiptType == "SOS_ALERT" && it.type == "SOS_CANCEL" && it.id == added.target) }

    /** Packet to drop when the queue is full: receipts first, then relayed copies, oldest first. Never our own SOS or cancel. */
    fun evictionCandidate(queued: Collection<PacketMeta>): String? =
        queued.filter { it.type == "SOS_ACK" }.minByOrNull { it.timestamp }?.id
            ?: queued.filter { it.hops > 0 }.minByOrNull { it.timestamp }?.id

    // Inbox repeats: a peer resends its whole queue now and then. A packet the app
    // already handled is not handed to it again for this long.
    const val HANDLED_FOR_MS = 5 * 60000L

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
    // keeps advertising for its whole TTL. When all are read, a new round starts
    // only if `newRound` allows it; otherwise the reader is told NOTHING_NEW.
    const val NOTHING_NEW = -2
    fun nextForReader(hashes: List<Int>, seen: MutableSet<Int>, newRound: Boolean = true): Int {
        if (hashes.isEmpty()) return -1
        seen.retainAll(hashes.toSet())
        val fresh = hashes.indexOfFirst { it !in seen }
        if (fresh >= 0) return fresh
        if (!newRound) return NOTHING_NEW
        seen.clear()
        return 0
    }

    // A reader that already has every packet gets a short "nothing new" answer
    // instead of the whole queue again. It still gets a full repeat now and
    // then, in case it lost something. A read that follows a finished packet on
    // the same link (back to back) is a continuation and never starts a round.
    const val FULL_ROUND_EVERY_MS = 60000L
    fun mayStartRound(lastRoundAt: Long?, lastFinishedAt: Long?, now: Long): Boolean =
        !transferIsLive(lastFinishedAt, now) && (lastRoundAt == null || now - lastRoundAt >= FULL_ROUND_EVERY_MS)

    // Packets one reader takes in a single connection before letting others in.
    const val PACKETS_PER_LINK = 40
}
