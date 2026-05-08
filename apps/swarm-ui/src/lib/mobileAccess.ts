import { invoke } from '@tauri-apps/api/core';
import type { DeviceInfo, PairingSessionInfo } from './types';

type PairingPayloadWire = {
  v: number;
  host: string;
  port: number;
  cert_fingerprint: string;
  code: string;
  pairing_secret: string;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function pairingStringFromSession(session: PairingSessionInfo): string {
  const payload: PairingPayloadWire = {
    v: 1,
    host: session.host,
    port: session.port,
    cert_fingerprint: session.cert_fingerprint,
    code: session.code,
    pairing_secret: session.pairing_secret,
  };
  const encoded = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return `swarm-pair:${encoded}`;
}

export async function fetchDevices(): Promise<DeviceInfo[]> {
  return invoke<DeviceInfo[]>('mobile_access_fetch_devices');
}

export async function createPairingSession(): Promise<PairingSessionInfo> {
  return invoke<PairingSessionInfo>('mobile_access_create_pairing_session');
}

export async function cancelPairingSession(sessionId: string): Promise<void> {
  await invoke('mobile_access_cancel_pairing_session', { sessionId });
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await invoke('mobile_access_revoke_device', { deviceId });
}
