// Generate any missing test wallets into .env. Prints addresses only, never keys.
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const root = resolve(import.meta.dirname, "..");
const envPath = resolve(root, ".env");
if (!existsSync(envPath)) copyFileSync(resolve(root, ".env.example"), envPath);

const roles = ["DEPLOYER", "DEV", "GUARDED_USER", "UNGUARDED_USER", "AGENT"];
let text = readFileSync(envPath, "utf8");
const created: string[] = [];

for (const role of roles) {
  const key = `${role}_PK`;
  const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (m && m[1].trim()) continue;
  const pk = generatePrivateKey();
  text = m ? text.replace(m[0], `${key}=${pk}`) : `${text.trimEnd()}\n${key}=${pk}\n`;
  created.push(role);
}
writeFileSync(envPath, text);

for (const role of roles) {
  const pk = text.match(new RegExp(`^${role}_PK=(.*)$`, "m"))![1].trim() as Hex;
  const tag = created.includes(role) ? "(new)" : "(existing)";
  console.log(`${role.padEnd(15)} ${privateKeyToAccount(pk).address} ${tag}`);
}
