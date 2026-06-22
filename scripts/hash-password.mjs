#!/usr/bin/env node
/**
 * Generate an AUTH_PASSWORD_HASH for the Ring dashboard.
 *
 * Usage:
 *   npm run auth:hash               # prompts for the password (hidden)
 *   npm run auth:hash -- "secret"   # password as an argument
 *
 * Output format matches src/auth.ts: scrypt$<saltHex>$<hashHex>
 * This script makes no network calls and needs no build step.
 */
import crypto from "crypto";
import readline from "readline";
import { promisify } from "util";

const scrypt = promisify(crypto.scrypt);
const SCRYPT_KEYLEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Mute echo so the password is not shown as it is typed.
    const onData = () => {
      rl.output.write(`\r${question}`);
    };
    process.stdin.on("data", onData);

    rl.question(question, (answer) => {
      process.stdin.removeListener("data", onData);
      rl.output.write("\n");
      rl.close();
      resolve(answer);
    });

    rl._writeToOutput = () => {};
  });
}

async function main() {
  let password = process.argv[2];

  if (!password) {
    password = await promptHidden("Password: ");
  }

  if (!password) {
    console.error("No password provided.");
    process.exit(1);
  }

  const hash = await hashPassword(password);

  console.log("\nAdd this line to your .env file:\n");
  console.log(`AUTH_PASSWORD_HASH=${hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
