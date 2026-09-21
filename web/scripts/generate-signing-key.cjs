#!/usr/bin/env node
/**
 * Generate the Ed25519 keypair for the discovery signature layer.
 *
 * The same key family the MCP registry proof uses: one keypair, three confirmations
 * (JWKS, registry proof file, DNS TXT). Run this ONCE, on a machine you trust,
 * then put the halves where they belong:
 *
 *   - MCP_REGISTRY_PUBLIC_KEY   -> Vercel env (public; it is already published)
 *   - MCP_REGISTRY_PRIVATE_KEY  -> Vercel env (secret)
 *   - the DNS TXT record        -> update it if it does not carry this public key yet
 *
 * The private key is printed to YOUR terminal. It is never written to a file by
 * this script and it never reaches the repository.
 */

const { generateKeyPairSync, createPublicKey } = require("node:crypto");

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

// The registry proof format wants the RAW 32-byte public key, base64. The SPKI
// DER wraps it with a fixed 12-byte prefix; the raw key is the last 32 bytes.
const spki = publicKey.export({ format: "der", type: "spki" });
const raw = spki.subarray(spki.length - 32).toString("base64");

// PKCS8 DER for the private half, base64, so it pastes into an env var with no
// newlines to lose. (PKCS8 DER for ed25519 is a fixed 16-byte prefix + 32 raw.)
const der = privateKey.export({ format: "der", type: "pkcs8" });
const pkcs8 = der.toString("base64");

console.log("Discovery signing keypair generated. Move the halves like this:\n");
console.log("  # Vercel env (public):");
console.log(`  MCP_REGISTRY_PUBLIC_KEY=${raw}\n`);
console.log("  # Vercel env (secret, base64 PKCS8, no newlines):");
console.log(`  MCP_REGISTRY_PRIVATE_KEY=${pkcs8}\n`);
console.log("  # DNS TXT at the apex (swampai.world), if not already present:");
console.log(`  v=MCPv1; k=ed25519; p=${raw}\n`);
console.log("Then redeploy. The verifier asserts the whole chain:");
console.log("  node scripts/verify-discovery.cjs https://www.swampai.world\n");
console.log("The private key above is the ONLY copy this script produces. Store it");
console.log("somewhere safe before closing the terminal.");
