/**
 * @fileoverview Network service to check for active internet connectivity.
 */

import { apiUrl, loadApiSettings } from '../constants/api';

import NetInfo, { NetInfoState, NetInfoSubscription } from '@react-native-community/netinfo';

export class NetworkService {
  private static checking: Promise<{ isOnline: boolean; connectionType: string }> | undefined;
  /**
   * Checks the network connectivity.
   * Verifies both the interface connection and actual internet reachability 
   * to avoid false positives with captive portals or local-only connections.
   */
  public static async checkConnectivity(): Promise<{ isOnline: boolean; connectionType: string }> {
    return this.checking ??= this.probe().finally(() => { this.checking = undefined; });
  }
  private static async probe(): Promise<{ isOnline: boolean; connectionType: string }> {
    await loadApiSettings();
    const state: NetInfoState = await NetInfo.fetch();
    
    const confirmedOnline = !!state.isConnected && await this.pingServer();
    return {
      isOnline: confirmedOnline,
      connectionType: state.type
    };
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

  /**
   * Performs a quick, lightweight ping to a reliable server (or our own backend)
   * to confirm reachability.
   */
  private static async pingServer(): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);
    try {
      
      const response = await fetch(apiUrl('/health'), {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store'
      });
      
      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    } finally { clearTimeout(timeoutId); }
  }
}
