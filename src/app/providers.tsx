'use client';
import { MiniKitProvider } from '@worldcoin/minikit-js/minikit-provider';

// MiniKit MUST be initialized with the app_id, otherwise World ID verify cannot
// resolve the app's actions and fails with "Action not found" even when the
// action is registered. The appId is passed via the provider's `props` field.
const APP_ID = process.env.NEXT_PUBLIC_WORLD_APP_ID || '';

export function Providers({ children }: { children: React.ReactNode }) {
  return <MiniKitProvider props={{ appId: APP_ID }}>{children}</MiniKitProvider>;
}
