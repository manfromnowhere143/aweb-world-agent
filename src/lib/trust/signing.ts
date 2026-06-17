/**
 * Ed25519 receipt sealing.
 *
 * Hash-chaining makes a receipt tamper-EVIDENT. Signing makes it AUTHENTIC:
 * the governance runtime signs the chain head (the last entry hash) with an
 * Ed25519 key, so anyone with the public key can prove the receipt was produced
 * by this runtime and not forged. The public key is published with every receipt
 * and the seal is independently verifiable in-browser (Web Crypto).
 */
import { generateKeyPairSync, sign as nodeSign, createPrivateKey, createPublicKey } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ReceiptChain, ReceiptSeal } from './types';

interface KeyMaterial {
  privatePkcs8B64: string;
  publicSpkiB64: string;
}

const KEY_FILE = path.join(process.cwd(), 'data', 'signing-key.json');
let cached: KeyMaterial | null = null;

async function loadOrCreateKey(): Promise<KeyMaterial> {
  if (cached) return cached;
  // Prod: private key supplied via env (PKCS8 DER, base64).
  const envKey = process.env.TRUST_SIGNING_PRIVATE_KEY;
  if (envKey) {
    const priv = createPrivateKey({ key: Buffer.from(envKey, 'base64'), format: 'der', type: 'pkcs8' });
    const pub = createPublicKey(priv);
    cached = { privatePkcs8B64: envKey, publicSpkiB64: pub.export({ type: 'spki', format: 'der' }).toString('base64') };
    return cached;
  }
  // Dev: stable keypair persisted under data/.
  try {
    cached = JSON.parse(await fs.readFile(KEY_FILE, 'utf8')) as KeyMaterial;
    return cached;
  } catch {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    cached = {
      privatePkcs8B64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      publicSpkiB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    };
    await fs.mkdir(path.dirname(KEY_FILE), { recursive: true });
    await fs.writeFile(KEY_FILE, JSON.stringify(cached));
    return cached;
  }
}

/** Sign the head of a completed receipt chain. */
export async function sealReceipt(chain: ReceiptChain, now: () => string): Promise<ReceiptSeal | null> {
  if (!chain.entries.length) return null;
  const head = chain.entries[chain.entries.length - 1]!.hash;
  const km = await loadOrCreateKey();
  const priv = createPrivateKey({ key: Buffer.from(km.privatePkcs8B64, 'base64'), format: 'der', type: 'pkcs8' });
  const signature = nodeSign(null, Buffer.from(head, 'utf8'), priv).toString('base64');
  return { algorithm: 'Ed25519', publicKey: km.publicSpkiB64, signature, signedHash: head, signedAt: now() };
}

/** The runtime's published verification key (base64 SPKI). */
export async function publicKeyB64(): Promise<string> {
  return (await loadOrCreateKey()).publicSpkiB64;
}
