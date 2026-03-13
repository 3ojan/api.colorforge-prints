#!/usr/bin/env node
/**
 * Stripe webhook listener for local development.
 * Downloads Stripe CLI if needed and forwards events to localhost:4000.
 *
 * Run: npm run stripe:webhook
 *
 * Copy the whsec_... from output into .env as STRIPE_WEBHOOK_SECRET
 */

import { spawn, execSync } from "child_process";
import { chmodSync, existsSync, writeFileSync } from "fs";
import { mkdir, rm } from "fs/promises";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STRIPE_VERSION = "1.37.2";
const CACHE_DIR = path.join(__dirname, "..", ".stripe-cli");
const STRIPE_BIN = path.join(CACHE_DIR, "stripe");

const MAC_URL =
  process.arch === "arm64"
    ? `https://github.com/stripe/stripe-cli/releases/download/v${STRIPE_VERSION}/stripe_${STRIPE_VERSION}_mac-os_arm64.tar.gz`
    : `https://github.com/stripe/stripe-cli/releases/download/v${STRIPE_VERSION}/stripe_${STRIPE_VERSION}_mac-os_x86_64.tar.gz`;

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { redirect: "follow" }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        download(res.headers.location).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function ensureStripeCli() {
  if (existsSync(STRIPE_BIN)) return STRIPE_BIN;

  if (process.platform !== "darwin") {
    console.error("Auto-download only on macOS. Install manually:");
    console.error("  brew install stripe/stripe-cli/stripe");
    process.exit(1);
  }

  console.log("Downloading Stripe CLI...");
  await mkdir(CACHE_DIR, { recursive: true });
  const gz = await download(MAC_URL);
  const tgzPath = path.join(CACHE_DIR, "stripe.tar.gz");
  writeFileSync(tgzPath, gz);
  execSync(`tar -xzf "${tgzPath}" -C "${CACHE_DIR}"`, { stdio: "pipe" });
  await rm(tgzPath, { force: true });
  if (existsSync(STRIPE_BIN)) {
    chmodSync(STRIPE_BIN, 0o755);
    console.log("Stripe CLI ready.\n");
    return STRIPE_BIN;
  }
  throw new Error("Extract failed");
}

async function main() {
  const bin = await ensureStripeCli();
  spawn(bin, ["listen", "--forward-to", "localhost:4000/api/webhooks/stripe"], {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
  });
}

main().catch((err) => {
  console.error(err.message);
  console.error("\nInstall manually: brew install stripe/stripe-cli/stripe");
  process.exit(1);
});
