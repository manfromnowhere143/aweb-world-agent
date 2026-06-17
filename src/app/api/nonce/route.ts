import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export const runtime = 'nodejs';

/** Issue a SIWE nonce (>=8 alphanumeric), stored in an httpOnly cookie. */
export async function GET() {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  (await cookies()).set('siwe-nonce', nonce, { httpOnly: true, secure: true, sameSite: 'none', maxAge: 600, path: '/' });
  return NextResponse.json({ nonce });
}
