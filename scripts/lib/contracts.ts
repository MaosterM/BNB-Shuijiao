// Forge artifacts + minimal PancakeSwap V2 ABIs + deploy/price helpers.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { parseAbi, type Abi, type Address, type Hex } from "viem";
import { ROOT, confirm, publicClient, wallet, type Role } from "./env.ts";

export const DEAD: Address = "0x000000000000000000000000000000000000dEaD";
export const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 120);

export function forgeBuild() {
  const local = resolve(homedir(), ".foundry/bin/forge" + (process.platform === "win32" ? ".exe" : ""));
  const forge = process.env.FORGE || (existsSync(local) ? `"${local}"` : "forge");
  mkdirSync(resolve(ROOT, "contracts/out"), { recursive: true }); // forge can't create it on paths with quotes
  mkdirSync(resolve(ROOT, "contracts/cache"), { recursive: true });
  execSync(`${forge} build`, { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
}

export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(resolve(ROOT, `contracts/out/${name}.sol/${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

export async function deploy(role: Role, name: string, args: unknown[] = []): Promise<Address> {
  const { abi, bytecode } = artifact(name);
  const hash = await wallet(role).deployContract({ abi, bytecode, args });
  const r = await confirm(`deploy ${name}`, hash);
  return r.contractAddress!;
}

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function owner() view returns (address)",
  "function transferOwnership(address)",
  "function mint(address,uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const routerAbi = parseAbi([
  "function addLiquidityETH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline) payable returns (uint256,uint256,uint256)",
  "function removeLiquidityETH(address token,uint256 liquidity,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline) returns (uint256,uint256)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[])",
]);

export const factoryAbi = parseAbi(["function getPair(address,address) view returns (address)"]);

export const pairAbi = parseAbi([
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
  "event Sync(uint112 reserve0,uint112 reserve1)",
  "event Burn(address indexed sender,uint256 amount0,uint256 amount1,address indexed to)",
  "event Mint(address indexed sender,uint256 amount0,uint256 amount1)",
]);

/** Pool reserves as {token, bnb} regardless of token0 ordering. */
export async function reserves(pair: Address, token: Address) {
  const [[r0, r1], t0] = await Promise.all([
    publicClient.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" }),
    publicClient.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
  ]);
  const tokenIs0 = t0.toLowerCase() === token.toLowerCase();
  return { token: tokenIs0 ? r0 : r1, bnb: tokenIs0 ? r1 : r0, tokenIs0 };
}

/** Spot price in BNB per 1 RUGME (float, display only). */
export async function price(pair: Address, token: Address) {
  const r = await reserves(pair, token);
  return r.token === 0n ? 0 : Number(r.bnb) / Number(r.token);
}

/** What `amount` RUGME would fetch if sold right now (with 0.25% fee), in wei. */
export function quoteSell(amount: bigint, r: { token: bigint; bnb: bigint }) {
  if (amount === 0n || r.token === 0n) return 0n;
  const inWithFee = amount * 9975n;
  return (inWithFee * r.bnb) / (r.token * 10000n + inWithFee);
}
