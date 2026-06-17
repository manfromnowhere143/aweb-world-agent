import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifySiweMessage } from '@worldcoin/minikit-js';
import { isDevMode } from '@/lib/world/config';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const { payload, nonce } = (await req.json()) as { payload: unknown; nonce: string };
    const cookieNonce = (await cookies()).get('siwe-nonce')?.value;

    if (isDevMode()) {
      // Dev: accept and synthesize a deterministic wallet identity.
      return NextResponse.json({ isValid: true, dev: true, address: '0xDEV0000000000000000000000000000000000000', username: 'dev.human' });
    }

    if (!cookieNonce || cookieNonce !== nonce) {
      return NextResponse.json({ isValid: false, error: 'nonce mismatch' }, { status: 400 });
    }
    const result = await verifySiweMessage(payload as never, nonce);
    if (!result.isValid) return NextResponse.json({ isValid: false }, { status: 401 });
    return NextResponse.json({ isValid: true, address: result.siweMessageData.address });
  } catch (e) {
    return NextResponse.json({ isValid: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
