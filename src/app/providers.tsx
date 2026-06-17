'use client';
import { MiniKitProvider } from '@worldcoin/minikit-js/minikit-provider';

export function Providers({ children }: { children: React.ReactNode }) {
  return <MiniKitProvider>{children}</MiniKitProvider>;
}
