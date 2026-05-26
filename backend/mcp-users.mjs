/**
 * mcp-users.mjs — Encrypted user store for MCP per-user auth
 *
 * Each user is identified by an API key (UUID). Their private key is
 * encrypted with AES-256-GCM using MCP_MASTER_SECRET from .env.
 * File: backend/.mcp-users.enc.json
 */

import { randomBytes, createCipheriv, createDecipheriv, randomUUID, createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = process.env.MCP_STORE_PATH || join(process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname, ".mcp-users.enc.json");

function masterKey() {
  const secret = process.env.MCP_MASTER_SECRET;
  if (!secret || secret.length < 16) throw new Error("MCP_MASTER_SECRET must be set (min 16 chars) in .env");
  return createHash("sha256").update(secret).digest();
}

function encrypt(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("hex"), enc: enc.toString("hex"), tag: tag.toString("hex") };
}

function decrypt(record, key) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "hex"));
  decipher.setAuthTag(Buffer.from(record.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(record.enc, "hex")), decipher.final()]).toString("utf8");
}

function loadStore() {
  if (!existsSync(STORE_PATH)) return {};
  return JSON.parse(readFileSync(STORE_PATH, "utf8"));
}

function saveStore(store) {
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

/**
 * Register a new user. Returns the API key. Enforces 1 key per wallet.
 */
export async function registerUser(privateKey) {
  const { ethers } = await import("ethers");
  const wallet = new ethers.Wallet(privateKey);
  const address = wallet.address.toLowerCase();

  // Check if wallet already has a key
  const existing = await getKeyForWallet(address);
  if (existing) throw new Error("ALREADY_EXISTS");

  const key = masterKey();
  const apiKey = `aura_${randomUUID().replace(/-/g, "")}`;
  const encrypted = encrypt(privateKey, key);
  encrypted.address = address; // store address for lookup
  const store = loadStore();
  store[apiKey] = encrypted;
  saveStore(store);
  return apiKey;
}

/**
 * Get the API key for a wallet address. Returns { apiKey, address } or null.
 */
export async function getKeyForWallet(address) {
  const normalized = address.toLowerCase();
  const store = loadStore();
  for (const [apiKey, record] of Object.entries(store)) {
    if (record.address === normalized) {
      return { apiKey, address: normalized };
    }
  }
  return null;
}

/**
 * Delete the API key for a wallet address. Returns true if deleted.
 */
export async function deleteKeyForWallet(address) {
  const normalized = address.toLowerCase();
  const store = loadStore();
  for (const [apiKey, record] of Object.entries(store)) {
    if (record.address === normalized) {
      delete store[apiKey];
      saveStore(store);
      return true;
    }
  }
  return false;
}

/**
 * Resolve an API key to a decrypted private key. Returns null if not found.
 */
export async function resolveApiKey(apiKey) {
  const key = masterKey();
  const store = loadStore();
  const record = store[apiKey];
  if (!record) return null;
  try {
    return decrypt(record, key);
  } catch {
    return null; // tampered or wrong master key
  }
}

/**
 * List registered users (API key prefix + address only, never the full key).
 */
export async function listUsers() {
  const key = masterKey();
  const store = loadStore();
  const { ethers } = await import("ethers");
  const users = [];
  for (const [apiKey, record] of Object.entries(store)) {
    try {
      const pk = decrypt(record, key);
      const wallet = new ethers.Wallet(pk);
      users.push({ apiKeyPrefix: apiKey.slice(0, 12) + "...", address: wallet.address });
    } catch {
      users.push({ apiKeyPrefix: apiKey.slice(0, 12) + "...", address: "(decrypt failed)" });
    }
  }
  return users;
}
