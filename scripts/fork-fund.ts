// DEV ONLY: give every role 1 BNB on a local anvil fork (RPC_HTTP=http://127.0.0.1:8545). Refuses on real RPCs.
import { parseEther, toHex } from "viem";
import { ROLES, RPC_HTTP, address, assertTestnet, publicClient, run } from "./lib/env.ts";

run(async () => {
  if (!/127\.0\.0\.1|localhost/.test(RPC_HTTP)) throw new Error("fork-fund only runs against a local anvil fork");
  await assertTestnet();
  for (const role of ROLES) {
    await publicClient.request({ method: "anvil_setBalance" as any, params: [address(role), toHex(parseEther("1"))] as any });
    console.log(`${role} funded with 1 BNB (fork)`);
  }
});
