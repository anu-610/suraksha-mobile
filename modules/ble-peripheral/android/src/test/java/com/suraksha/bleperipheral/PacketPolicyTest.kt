package com.suraksha.bleperipheral

import org.junit.Assert.*
import org.junit.Test

class PacketPolicyTest {
    @Test fun cancellationCannotBeReplacedByDelayedOrNewerAlert() {
        val cancelled = PacketVersion("a", "SOS_CANCEL", 4, 2000)
        assertFalse(PacketPolicy.canReplace(cancelled, PacketVersion("a", "SOS_ALERT", 3, 1000)))
        assertFalse(PacketPolicy.canReplace(cancelled, PacketVersion("a", "SOS_ALERT", 5, 3000)))
        assertFalse(PacketPolicy.canReplace(cancelled, PacketVersion("stranger", "SOS_CANCEL", 6, 4000)))
    }
    @Test fun newerLocationsWinAndWithdrawalIsTerminal() {
        assertFalse(PacketPolicy.canReplace(PacketVersion("a", "SOS_ALERT", 4, 2000), PacketVersion("a", "SOS_ALERT", 3, 3000)))
        assertFalse(PacketPolicy.canReplace(PacketVersion("h", "SOS_HELPER", 2, 2000, "withdrawn"), PacketVersion("h", "SOS_HELPER", 3, 3000, "accepted")))
    }
    @Test fun controlsHaveReservedCapacityAndExistingEntriesRemainReplaceable() {
        assertFalse(PacketPolicy.hasCapacity(100, false, 4))
        assertTrue(PacketPolicy.hasCapacity(100, false, 0))
        assertTrue(PacketPolicy.hasCapacity(132, true, 0))
        assertFalse(PacketPolicy.hasCapacity(132, false, 0))
        assertTrue(PacketPolicy.priority("SOS_CANCEL", "", false) < PacketPolicy.priority("SOS_ALERT", "", true))
    }
    @Test fun duplicateLongerPathsCannotReplaceShorterRoutes() {
        val short = PacketVersion("a", "SOS_ALERT", 1, 1000, hops = 1)
        assertFalse(PacketPolicy.canReplace(short, short.copy(hops = 14)))
        assertTrue(PacketPolicy.canReplace(short, short.copy(hops = 0)))
        assertTrue(PacketPolicy.canReplace(short, short.copy(revision = 2, hops = 14)))
    }
    @Test fun retriesAndEqualPriorityDoNotPreemptRotation() {
        assertFalse(PacketPolicy.shouldPreempt("a", "b", 4, 4, false))
        assertFalse(PacketPolicy.shouldPreempt("a", "b", 4, 4, true))
        assertFalse(PacketPolicy.shouldPreempt("a", "a", 4, 4, false))
        assertTrue(PacketPolicy.shouldPreempt("a", "a", 4, 4, true))
        assertTrue(PacketPolicy.shouldPreempt("a", "b", 4, 0, true))
    }
    @Test fun scanStartsStayBelowAndroidThrottle() {
        assertEquals(0, PacketPolicy.scanStartDelay(listOf(1000L, 2000L, 3000L), 4000L))
        val wait = PacketPolicy.scanStartDelay(listOf(1000L, 2000L, 3000L, 4000L), 5000L)
        assertEquals(1000L + 30000L - 5000L + 500L, wait)
        // Starts older than the window no longer count.
        assertEquals(0, PacketPolicy.scanStartDelay(listOf(1000L, 2000L, 3000L, 4000L), 40000L))
    }
    @Test fun reconnectAfterGapRestartsServerTransfer() {
        assertFalse(PacketPolicy.transferIsLive(null, 5000L))
        assertTrue(PacketPolicy.transferIsLive(4900L, 5000L))
        assertFalse(PacketPolicy.transferIsLive(1000L, 5000L))
    }
}
