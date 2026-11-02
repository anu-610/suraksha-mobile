/**
 * @fileoverview Network service to check for active internet connectivity.
 */

import NetInfo, { NetInfoState, NetInfoSubscription } from '@react-native-community/netinfo';

export class NetworkService {
  private static checking: Promise<{ isOnline: boolean; connectionType: string }> | undefined;
  /**
   * Checks the network connectivity.
   * Only the interface state is checked. A short backend probe used to gate
   * uploads, but it failed on slow or local-only Wi-Fi (no public internet) and
   * then relayed SOS packets were never tried. The real API request and the
   * durable retry policy now decide whether delivery worked.
   */
  public static async checkConnectivity(): Promise<{ isOnline: boolean; connectionType: string }> {
    return this.checking ??= this.probe().finally(() => { this.checking = undefined; });
  }
  private static async probe(): Promise<{ isOnline: boolean; connectionType: string }> {
    const state: NetInfoState = await NetInfo.fetch();
    // null means Android has not decided yet; attempting is cheaper than waiting.
    return { isOnline: state.isConnected !== false, connectionType: state.type };
  }

  /**
   * Subscribes to network state changes.
   * @param callback Function to call when network state changes
   * @returns A function to unsubscribe
   */
  public static subscribe(callback: (isOnline: boolean) => void): NetInfoSubscription {
    return NetInfo.addEventListener(state => {
      const isOnline = !!state.isConnected;
      callback(isOnline);
    });
  }
}
