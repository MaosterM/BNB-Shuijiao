# Ejector Seat

**A non-custodial anti-rug agent on BNB Smart Chain.** You hold a small, risky token. Ejector Seat watches the team's wallets and the liquidity pool. The moment the team starts dumping (a team wallet sells into the pool, moves a big share of its bag, pulls liquidity, or mints new supply), plain deterministic code sells *your* tokens for BNB, usually before the main dump lands.

The agent's **only** power over your funds is *"sell this token and send the proceeds back to the owner"*. An LLM writes the pre-flight risk brief and the post-ejection explanation. It is never in the trigger-to-sell path and never touches a key.

> New to the project? Read [HowItWorks.md](HowItWorks.md) first. It's a plain-language explanation of the system and the theory behind it, with no code.

> BSC **testnet only** (chainId 97). Every script refuses to run if the RPC reports any other chain or looks like mainnet.

## Demo result (BSC testnet, real PancakeSwap V2)

`npm run demo` resets the scenario, starts the agent, waits for `GUARD ARMED`, then runs the rug. DEV sells 5% of its holdings, waits 8 s, dumps the rest, and removes all liquidity.

|                | start value   | final value   | kept      |
|----------------|---------------|---------------|-----------|
| **GUARDED**    | 0.005869 tBNB | 0.004906 tBNB | **83.6%** |
| **UNGUARDED**  | 0.005869 tBNB | 0.000003 tBNB | **0.1%**  |

The price crashed 89.8%. The sell was broadcast **185–213 ms** after the agent saw the triggering block. The acceptance test passed 3 times out of 3 back-to-back runs, each about 65 s including the reset.

The transactions below come from one run, in order:

| Step | Tx |
|---|---|
| DEV sells 5% → `TEAM_DEX_SELL` trigger | [0x4135…1b41](https://testnet.bscscan.com/tx/0x41358d0898de261c5a824329b55792aefbbd671d49e14ddea7b3fac6af26b41b) |
| Ejector Seat sells the guarded vault (same second) | [0x1d5f…1be0](https://testnet.bscscan.com/tx/0x1d5fe0b618ad53161c84b6fab1362f996051579ae2ae45c35a2aa5702c1c1be0) |
| Altana mode: sale from the user's *own* wallet through a scoped session key | [0xd2c9…3f34](https://testnet.bscscan.com/tx/0xd2c9878f4ae5615033949d269dff723f5d4d501f580acee2b597234f6f623f34) |
| Altana session grant (scope: `SafeExit.exit` only) | [0x9336…7f2e](https://testnet.bscscan.com/tx/0x933639744c3c78fd8e7fe730043a1a9d1bd3cd175b603d07e27e699e3f8c7f2e) |

## Why it is safe: the only permission is sell-to-owner

* **`SafeExit.sol`**, about 30 lines. `exit(token, amountIn, minOutBNB)` pulls the tokens from `msg.sender`, swaps them on PancakeSwap, and sends the BNB to `msg.sender`. There is **no recipient parameter**, so the proceeds can only go back to whoever is selling.
* **`GuardedVault.sol`** holds the user's tokens. The guardian (AGENT) can call exactly one function, `eject(minOut)`, which sells through SafeExit, and the BNB stays in the vault. Only the owner can `withdraw` or `setGuardian`. There is no other way to move funds.
* **Altana mode** (`GUARD_MODE=altana`). The user's own EOA becomes an Altana EIP-7702 account. Each reset gives the agent a fresh session key, stored in the gitignored, owner-only file `.altana/session-key.json` (one key per grant, because Altana's on-chain KeyStore registers each key only once). The key's on-chain policy allows only `SafeExit.exit(address,uint256,uint256)` on one SafeExit address, has a native spend cap of 0.002 tBNB/day (relay fees), and expires in 24 h. The Altana account validator enforces this on-chain. `npm run altana-test` shows the same session being **refused** when it tries to transfer RUGME, approve, or send BNB to AGENT.
* **Tested.** `forge test` passes 6/6 against the real PancakeSwap router:
  * proceeds always return to the caller or the vault
  * `amountIn=0` sells the full balance
  * a non-guardian cannot eject
  * the guardian cannot withdraw, re-point, or `transferFrom`
  * no allowance is left over after an eject
  * `minOut` is enforced

  `npm run eject-test` repeats the vault checks on-chain.
* **No LLM in the hot path.** The trigger path is logs → `evaluateBatch()` (a pure function) → a pre-built tx, signed locally → one `sendRawTransaction`. The nonce, gas, and protected amount are read once, when the guard arms.

## Architecture

```
                     BSC testnet (chain 97)
   ┌──────────────────────────────────────────────────────────┐
   │ RUGME token ── Transfer ─┐     PancakeSwap V2 RUGME/WBNB │
   │                          │     pair ── Swap/Sync/Burn ─┐ │
   └──────────────────────────┼─────────────────────────────┼─┘
                              ▼                             ▼
   watcher.ts   WebSocket new heads + 1 s HTTP poll, 3-block re-scan,
                de-dup by txHash:logIndex
                              │ normalized logs
                              ▼
   triggers.ts  pure functions (unit-tested)
                T1 TEAM_DEX_SELL  team → pool ≥1% of its bag
                T2 TEAM_BIG_MOVE  team → non-safe address >20%
                T3 LIQUIDITY_PULL Burn >10% / BNB reserve −10% w/o swap
                T4 MINT           Transfer from 0x0
                              │ first trigger only
                              ▼
   executor.ts  eject(): minOut = quote × (1 − 15%), sign locally,
                ONE submission ─┬─▶ GuardedVault.eject(minOut)    (vault mode)
                                └─▶ Altana session → SafeExit.exit (altana mode)
                                             │
                                             ▼  BNB → owner, always

   off the hot path:  preflight.ts (facts by code, LLM only rephrases) · explainer.ts
                      bus.ts → server.ts :8788 /state + /events (SSE)
                      → dashboard server :8787 (relay + demo controls, localhost only)
                      → dashboard/index.html (Chart.js)
```

## Run it: step by step

Run every command from the repo root (the folder containing `package.json`). Where Windows PowerShell and macOS/Linux differ, both are shown.

### Step 0. Install the prerequisites (once per machine)

| Tool | Version | Install | Check |
|---|---|---|---|
| Node.js | 20.12 or newer (tested on 22.23) | https://nodejs.org, or `winget install OpenJS.NodeJS.22` on Windows | `node --version` |
| Git | any recent version | https://git-scm.com | `git --version` |
| Foundry (`forge`) | 1.x | macOS/Linux: `curl -L https://foundry.paradigm.xyz \| bash` then `foundryup`. Windows: run the same two commands in **Git Bash**, then add `%USERPROFILE%\.foundry\bin` to your PATH | `forge --version` |

You don't need Foundry on PATH for the demo itself. The scripts find `~/.foundry/bin/forge` automatically. You only need it on PATH to run `forge test` by hand.

### Step 1. Get the code and install dependencies

```bash
git clone <this-repo-url> BNB-Shuijiao
cd BNB-Shuijiao
npm install
```

This installs viem, tsx, TypeScript, OpenZeppelin, forge-std and the Altana SDK. There are no other services to set up.

### Step 2. Create the test wallets

```bash
npm run wallets
```

* If `.env` doesn't exist, this creates it from `.env.example`.
* It generates five testnet private keys: DEPLOYER, DEV, GUARDED_USER, UNGUARDED_USER and AGENT.
* It prints **only the addresses**. The keys stay in `.env`, which is gitignored.
* Running it again never overwrites keys that already exist.

**Skip this step** if you were handed a ready-made `.env`. Never commit or paste a `.env`.

### Step 3. Fund the wallets with testnet BNB (tBNB)

1. Check what each wallet needs:
   ```bash
   npm run fund
   ```
2. Get free tBNB for the **DEPLOYER** address that was printed, about 0.1 tBNB. Use either of these:
   * Telegram: message https://t.me/bnbchain_official_bot with `I would like to get tBNB to my wallet <DEPLOYER address>`
   * Web: https://www.bnbchain.org/en/testnet-faucet
3. Once it arrives (`npm run fund` shows DEPLOYER `ok`), let DEPLOYER top up the other four wallets:
   ```bash
   npm run fund -- --distribute
   ```
   Each transfer prints a BscScan link.

0.1 tBNB is enough for dozens of demo runs. Gas is about 0.1 gwei, and every reset pulls the pool's liquidity back to DEPLOYER.

### Step 4. (Optional) Run the tests

```bash
npm test                 # 11 unit tests for the trigger logic (no network)
npm run test:contracts   # 6 Foundry tests forked from BSC testnet (needs internet)
```

### Step 5. Start the dashboard server

Open a terminal and leave it running for the whole session:

```bash
npm run dashboard
```

You should see:

```
Dashboard: http://localhost:8787  (relaying agent API on :8788; controls enabled, localhost only)
```

This one server does three things:
* serves the web page
* relays the agent's live state to the page
* runs the demo scripts when you press the buttons

The agent itself is started from the page in Step 7. You don't start it separately.

### Step 6. Open the app

Open **http://localhost:8787** in a browser on the same machine. The server only accepts connections from this computer.

Before any agent has run, the status pill says **AGENT OFFLINE** and the cards show `–`. That's normal.

### Step 7. Run the demo from the dashboard

**One-click version:** press **▶ Run full demo**. It takes about 70 s:

1. **Reset** (about 35–45 s). A fresh RUGME token and PancakeSwap pool are deployed, the supply is distributed, and SafeExit plus the vault are deployed. Follow along in **Run output**.
2. **Arm.** The agent starts. The status pill turns amber, **● GUARD ARMED**, and the **risk brief** fills in: HIGH risk, team holds 30% of supply and 100% of the LP.
3. **Rug.** DEV sells 5% of its holdings. Within about a second the **WITH EJECTOR SEAT** card (the GUARDED user) turns green, **EJECTED ✓**, with the eject tx link.
4. Eight seconds later DEV dumps the rest and pulls the liquidity. The chart crashes about 90% and the **WITHOUT EJECTOR SEAT** card (the UNGUARDED user) turns red, at about −99.9%.
5. About 15 s after the ejection, the plain-English **explanation** appears above the event log.

**Step-by-step version** (better for narrating a pitch):

| Press | Wait until | Say |
|---|---|---|
| **1 · Reset scenario** | Run output shows `Reset done` | "Fresh risky token: DEV holds 30% and all the liquidity." |
| **2 · Arm guard** | Pill shows **● GUARD ARMED**, brief shows **HIGH RISK** | "Ejector Seat is watching the team wallet and the pool." |
| **3 · Rug it** | WITH EJECTOR SEAT card shows **EJECTED ✓** | "The first team sale triggered an instant sell. The user is out in BNB." |
| (nothing) | Chart crashes, WITHOUT EJECTOR SEAT card turns red | "Unguarded holders are left with nothing." |

To run again, just press **▶ Run full demo** (or **1 · Reset scenario**) again. Each reset stops the old agent, deploys a new token, and clears the page.

**Show what happens without protection:** press **1 · Reset scenario**, skip **2 · Arm guard**, and press **3 · Rug it**. The output warns that the guard isn't armed, and both users get rugged.

### Step 8. (Optional) Altana mode

In Altana mode the tokens stay in the user's own wallet, and the agent holds an Altana session key that may only call `SafeExit.exit`.

* **From the dashboard:** set **Guard** to **Altana session key**, then press **▶ Run full demo**. Each reset creates a fresh session automatically.
* **Prove the session's scope** (run after an Altana-mode reset):
  ```bash
  npm run altana-test
  ```
  All three lines should say `PASS … refused`.

Altana relay fees come out of GUARDED_USER's wallet, so keep it at 0.004 tBNB or more (`npm run fund -- --distribute`).

### Alternative: terminal only (no dashboard buttons)

```bash
npm run demo                 # reset → agent → rug → prints the final balances and ACCEPTANCE: PASS ✓
npm run demo -- --no-reset   # reuse the current scenario
```

For Altana mode from the terminal:

```powershell
# Windows PowerShell
$env:GUARD_MODE = "altana"; npm run demo; Remove-Item Env:GUARD_MODE
```

```bash
# macOS / Linux / Git Bash
GUARD_MODE=altana npm run demo
```

If `npm run dashboard` is also running, the page updates live during a terminal run too.

**Don't run a terminal demo while a dashboard action is running.** Both would use the same wallets.

### Stopping

* Press **Stop agent** to stop the guard. Pressing Reset also stops it.
* Press **Ctrl+C** in the `npm run dashboard` terminal to stop the server. Any agent it started is stopped with it.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `Error: listen EADDRINUSE … 8787` | An old dashboard is still running. On Windows: `Get-NetTCPConnection -LocalPort 8787 -State Listen \| % { Stop-Process -Id $_.OwningProcess -Force }`. On macOS/Linux: `kill $(lsof -t -i:8787)`. |
| `[api] not started (EADDRINUSE)` in Run output | Another agent is already running. Press **Stop agent**, or close the terminal running `npm run agent` / `npm run demo`. |
| Reset fails with `DEPLOYER has … tBNB, needs …` | Get more tBNB for DEPLOYER (Step 3), or lower `LIQ_BNB` in `.env`, for example `LIQ_BNB=0.03`. |
| `… exceeds the balance of the account` | One of the gas wallets ran dry. Run `npm run fund -- --distribute`. |
| Buttons are greyed out | An action is running (see "running: …" on the right), or the button doesn't apply right now: **Arm** while the agent runs, **Stop** while it doesn't. |
| Page shows AGENT OFFLINE | No agent is running. Press **2 · Arm guard** or **▶ Run full demo**. |
| Agent never arms (`agent did not arm`) | Usually the public RPC is slow or down. Retry. To switch RPC, set `RPC_HTTP` / `RPC_WS` in `.env` to another **BSC testnet** endpoint. Anything that isn't chain 97 is refused. |
| Altana: `An error occurred while executing calls` during reset | The Altana relay fails now and then, and the setup already retries once by itself. If it still fails, press Reset again. |
| Altana: `reverted: KeyStore: key already registered` | Fixed: every grant now uses a fresh session key. If you still see it, delete `.altana/session-key.json` and reset again. |
| Altana: `no Altana session key` | The agent was started in Altana mode before any Altana reset. Run a reset with Guard set to **Altana session key**. |
| `forge build` / `Command failed: forge build` | Install Foundry (Step 0). If the repo path contains an apostrophe, create the `contracts/out` folder by hand once. The scripts already do this automatically. |
| Chart.js doesn't load (no chart) | The page loads Chart.js from cdnjs, so the browser needs internet. Everything else still works. |

### Dashboard (http://localhost:8787)

The dashboard is built to be projected: dark theme, big type. It shows:
* the pre-flight risk brief
* the live RUGME price chart
* **WITH EJECTOR SEAT** vs **WITHOUT EJECTOR SEAT** value cards: the GUARDED and UNGUARDED users, each starting with the same 20,000 RUGME. The "with" card turns green, "EJECTED ✓", with the tx link.
* the live event log with BscScan links and the AI explanation
* the output of whatever script is running

**Controls** (they run the same scripts as the terminal commands):

| Button | What it does |
|---|---|
| **▶ Run full demo** | Reset → arm the guard → rug. The agent keeps running afterwards so the explanation can arrive. |
| **1 · Reset scenario** | `scripts/reset.ts`. Stops any running agent first, because a reset deploys a new token. |
| **2 · Arm guard** | Starts `agent/index.ts` and waits for `GUARD ARMED`. |
| **3 · Rug it** | `scripts/rug.ts`. Warns if the guard isn't armed; try it unarmed to show GUARDED getting rugged too. |
| **Stop agent** | Stops the guard. |
| **Guard** selector | GuardedVault or Altana session key. It applies to the next Reset or Run full demo. |

Only one action runs at a time; a second press gets HTTP 409. The control server listens on `127.0.0.1` only. Every run request must carry an `X-Ejector: 1` header, so another website open in the same browser can't trigger a run. Agent events go through the dashboard server, which reconnects automatically, so the page can stay open across many runs.

Other commands:

| Command | What it does |
|---|---|
| `npm run reset` | Fresh token, pool, distribution, SafeExit and vault in about 35 s. Pulls back any stranded liquidity and recycles tBNB. |
| `npm run rug` | DEV's 5% sell, pause, dump, liquidity pull, with the price printed after each step. |
| `npm run agent` | Run the guard on its own. Its API serves `:8788`. |
| `npm run eject-test` | AGENT ejects the vault, then checks that it cannot withdraw or re-point. |
| `npm run altana-setup` / `npm run altana-test` | Create the Altana wallet and session, then prove the session's scope. |
| `npm run preflight` | Print the risk brief JSON for the current scenario. |

Every address lives in `deployments.json`. Secrets live only in `.env` (gitignored). See `.env.example` for all the settings.

Cost: gas is about 0.1 gwei, so a full reset-and-rug cycle costs about 0.0005 tBNB net. The pool's 0.05 tBNB comes back on each reset. The Altana relay fees come out of the user's wallet, at roughly 0.0005–0.001 tBNB per action.

## BNB Agent Studio

`ejectorseat/` is a BNB Agent Studio seller project, scaffolded with `bag init`:
* A2A face, ERC-8183 rail, FREE price, Pieverse LLM `auto/free`
* the target is the 48h BNB testnet trial
* its work prompt makes it deliver Ejector Seat's **pre-flight risk brief** as a service
* `bag doctor` passes
* signing stays in Studio's fixed `signing.ts`, never an LLM tool

The guard itself runs locally as fixed code.

**Status: deployed to the BNB Chain managed trial, with an ERC-8004 identity registered on BSC testnet.**

| | |
|---|---|
| ERC-8004 agent | **#2643**: name "Ejector Seat", in registry [`0x8004A818…BD9e`](https://testnet.bscscan.com/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) (chain 97) |
| Agent wallet | [`0x34Da3e30…88f1`](https://testnet.bscscan.com/address/0x34Da3e301464CF4C85B8683dc8B146d4b23388f1) (a throwaway trial wallet, separate from the scenario wallets) |
| Metadata txs | name [0x2707…36c5](https://testnet.bscscan.com/tx/0x2707fac4d7d75f3feb98d44ec89f8d2a003d5a18b170771b4ad8b3729c7336c5) · description [0x2cf8…f060](https://testnet.bscscan.com/tx/0x2cf819215eb378d85951e1754414dcabc7df1a6220f7f244012cb2a0dee2f060) |
| A2A agent card | https://bnbagent-api.bnbchain.world/v1/rt/01M54542J6R4R84D6TZAATGC8N/.well-known/agent-card.json |

Reproduce: `cd ejectorseat && bag platform login && bag deploy --provider bnb && bag deploy verify --provider bnb`. The trial runtime is reclaimed after 48 h; the on-chain identity persists. Note: the trial's agent card advertises no OAuth scheme, so outside buyers can't call it yet. Giving buyers access would require a self-hosted deploy (`--provider aws`).

## Known limits

* **It can't beat a single-transaction rug.** If the team drains everything in one tx, or in the same block as the first signal, there is nothing left to react to. Ejector Seat protects against rugs that take more than one step, which is how most real dumps unfold.
* **A false alarm costs a sale.** It ejects on the first trigger, with 15% slippage tolerance, because a failed emergency sale is worse than a bad price. If the sale reverts anyway, it retries once with `minOut = 0`. A legitimate team transfer to an unlisted address (for example a new vesting contract) will eject you unless that address is on the safe list.
* Team wallets must be known in advance. The pre-flight brief flags concentration, but it doesn't discover hidden team wallets.
* Altana mode adds relay latency. Inclusion takes about 5 s, compared with about 1 s for the vault mode. That was still in time in the demo, where the dump comes 8 s after the first sale.
* This is a hackathon demo on testnet. It is unaudited, uses public RPCs, and runs on a single machine.
