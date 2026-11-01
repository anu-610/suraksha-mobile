package com.suraksha.bleperipheral

/** Pure policy: radio failures never decide whether an accepted packet is deleted. */
internal data class PacketVersion(val owner: String, val type: String, val revision: Long,
    val timestamp: Long, val helperState: String = "")

internal object PacketPolicy {
    fun canReplace(old: PacketVersion?, next: PacketVersion): Boolean {
        if (old == null) return true
        if (old.owner != next.owner) return false
        if (old.type == "SOS_CANCEL" && next.type != "SOS_CANCEL") return false
        if (next.type == "SOS_CANCEL" && old.type != "SOS_CANCEL") return true
        if (old.helperState == "withdrawn" && next.type == "SOS_HELPER" && next.helperState != "withdrawn") return false
        return next.revision > old.revision || (next.revision == old.revision && next.timestamp >= old.timestamp)
    }
    fun priority(type: String, helperState: String, requested: Boolean): Int = when {
        type == "SOS_CANCEL" -> 0
        helperState == "withdrawn" -> 1
        type == "SOS_ACK" -> 2
        type == "SOS_HELPER" || requested -> 3
        else -> 4
    }
    fun hasCapacity(size: Int, existing: Boolean, priority: Int): Boolean = existing || size < if (priority < 4) 132 else 100
}
