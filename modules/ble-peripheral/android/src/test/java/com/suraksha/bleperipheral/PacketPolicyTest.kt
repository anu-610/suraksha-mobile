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
}
