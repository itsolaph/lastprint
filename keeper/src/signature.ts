/**
 * Offchain mirror of LastprintOrders._requireValidSignature. Accepting a signature here that the contract
 * would reject only wastes keeper gas; rejecting one the contract would accept only inconveniences the user.
 * Keep the two in lockstep:
 *   1. ERC-6492 wrapper: accepted only if the maker already has code; the inner signature is then used.
 *   2. Maker with code: ERC-1271 isValidSignature(hash, sig) == 0x1626ba7e  -> valid.
 *   3. Otherwise (and as fallback for EIP-7702 accounts): 65-byte ECDSA, v in {27,28}, low-s, recovers maker.
 */
import { decodeAbiParameters, isAddressEqual, recoverAddress, type Address, type Hex, type PublicClient, parseAbi } from 'viem';

export const ERC6492_SUFFIX = '6492649264926492649264926492649264926492649264926492649264926492';
const ERC1271_MAGIC = '0x1626ba7e';
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

const erc1271Abi = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);

export type SigCheck = { ok: true } | { ok: false; reason: string };

export function isErc6492(sig: Hex): boolean {
  return sig.length >= 66 && sig.toLowerCase().endsWith(ERC6492_SUFFIX);
}

export function unwrapErc6492(sig: Hex): Hex {
  const body = sig.slice(0, sig.length - 64) as Hex;
  const [, , inner] = decodeAbiParameters([{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }], body);
  return inner;
}

/** Normalise v = 0/1 (some wallets) to 27/28. Leaves non-65-byte signatures untouched. */
export function normalizeV(sig: Hex): Hex {
  if (sig.length !== 132) return sig;
  const v = parseInt(sig.slice(130, 132), 16);
  if (v === 0 || v === 1) return (sig.slice(0, 130) + (v + 27).toString(16)) as Hex;
  return sig;
}

export async function ecdsaSignerIs(hash: Hex, sig: Hex, expected: Address): Promise<boolean> {
  if (sig.length !== 132) return false;
  const s = BigInt('0x' + sig.slice(66, 130));
  const v = parseInt(sig.slice(130, 132), 16);
  if (v !== 27 && v !== 28) return false;
  if (s > SECP256K1_HALF_N) return false;
  try {
    return isAddressEqual(await recoverAddress({ hash, signature: sig }), expected);
  } catch {
    return false;
  }
}

export async function erc1271Valid(client: PublicClient, signer: Address, hash: Hex, sig: Hex): Promise<boolean> {
  try {
    const r = await client.readContract({ address: signer, abi: erc1271Abi, functionName: 'isValidSignature', args: [hash, sig] });
    return r.toLowerCase() === ERC1271_MAGIC;
  } catch {
    return false;
  }
}

export async function checkOrderSignature(client: PublicClient, maker: Address, digest: Hex, signature: Hex): Promise<SigCheck> {
  const code = await client.getCode({ address: maker });
  const hasCode = !!code && code !== '0x';
  let sig = signature;
  if (isErc6492(sig)) {
    if (!hasCode) {
      return { ok: false, reason: 'Your smart wallet is not deployed yet. Approve the token first (this deploys it), then sign again.' };
    }
    try {
      sig = unwrapErc6492(sig);
    } catch {
      return { ok: false, reason: 'Malformed ERC-6492 signature.' };
    }
  }
  if (hasCode && (await erc1271Valid(client, maker, digest, sig))) return { ok: true };
  if (await ecdsaSignerIs(digest, sig, maker)) return { ok: true };
  return { ok: false, reason: 'Signature does not match the maker address.' };
}
