# How Ejector Seat Works

A plain-language guide to the ideas behind Ejector Seat: what a rug pull is, how the market mechanics work, how our agent spots danger and gets the user out, and why it's safe to give the agent that power. There's no code in here. For setup and commands, see `EjectorSeat.md`.

---

## 1. The problem: what a rug pull looks like

A **rug pull** is when the people behind a token cash out and leave everyone else holding something worthless. Small new tokens on BNB Chain make this easy:

* **The team keeps a big share of the supply.** In our demo, one team wallet holds 30% of all tokens.
* **The team controls the liquidity.** The pool that lets people trade the token was funded by the team, and they can withdraw it whenever they like.
* **The owner can create more tokens.** A "mint" function lets them print new supply and sell it.

Real rugs usually happen **in steps, not all at once**:

1. A small "test" sale, to check how much the market can absorb.
2. A short pause.
3. The big dump: sell everything.
4. Pull the liquidity, so nobody else can sell at all.

Each step leaves a public trace on the blockchain, and the gaps between steps are a window of a few seconds. **Ejector Seat lives in that window.** It sees step 1 and gets the user out before step 3.

---

## 2. Background: how trading works on PancakeSwap

To see why the price collapses, you need to know how the exchange works.

### The pool: two buckets and a formula

PancakeSwap doesn't use an order book. Each trading pair is a **pool** holding two "buckets": one of RUGME and one of BNB. The pool follows one rule:

> **RUGME in the pool × BNB in the pool = a constant (k)**

This is called a **constant-product market maker**. When someone sells RUGME, it goes into the RUGME bucket and BNB comes out of the BNB bucket, in whatever amount keeps the product the same (minus a 0.25% trading fee).

* **Price** is simply the ratio between the buckets: BNB in the pool ÷ RUGME in the pool.
* **Price impact:** a big sale changes the ratio a lot, so the price falls further the bigger the sale is compared to the pool.

### A worked example with our real demo numbers

The pool starts with **150,000 RUGME and 0.05 BNB**. DEV (the team wallet) holds **300,000 RUGME**, twice what's in the pool.

| Event | What happens to the pool | Price change |
|---|---|---|
| DEV sells 5% (15,000 RUGME) | 165,000 RUGME / ~0.0455 BNB | about **−17%** |
| Ejector Seat sells the GUARDED user's 20,000 RUGME | GUARDED gets ~0.0049 BNB, about 84% of its starting value | (more drop, but the user is out) |
| DEV dumps the remaining 285,000 RUGME | The pool is flooded with RUGME | about **−90%** total |
| DEV removes all liquidity | Both buckets are emptied | The price "stays" the same but **nobody can sell**; the pool is empty |

The worst of the damage comes from the **dump** and the **liquidity pull**. That's why getting out at the first sign is worth so much.

### Price vs. what you can actually get

There's a subtle point about the last row. When liquidity is removed **proportionally** (both buckets shrink together), the *ratio*, the "price", doesn't change. But the buckets are nearly empty, so if you try to sell, you get almost nothing.

That's why our dashboard values each user's tokens by **"how much BNB would I get if I sold right now"**, not by the quoted price. By that measure the UNGUARDED user ends with about **0.1%** of their starting value.

### Liquidity provider (LP) tokens

When someone puts tokens into a pool, they get **LP tokens**, a receipt that lets them withdraw their share later. If the **team holds the LP tokens**, they can pull the liquidity at any moment: "unlocked liquidity." Honest projects lock or burn their LP tokens. Our pre-flight risk check looks at exactly this.

---

## 3. Background: what the blockchain tells us

### Events: the blockchain's public announcements

Every time something happens on-chain, contracts emit **events** (also called logs), public announcements anyone can read. We listen to four kinds:

| Event | Emitted by | What it tells us |
|---|---|---|
| **Transfer** | The RUGME token | Tokens moved from wallet A to wallet B (including into the pool when someone sells, and from "nobody" when new tokens are minted) |
| **Swap** | The pool | A trade happened |
| **Sync** | The pool | The pool's new bucket sizes after any change |
| **Burn** | The pool | Liquidity was removed |

A sale shows up as a Transfer of RUGME **into the pool**, and the pool reports it with Swap and Sync events. That's how we can tell *who* sold *how much*.

### Blocks: the chain's heartbeat

Transactions are grouped into **blocks**, produced every second or so on BNB Smart Chain. When the dev's sale lands in a block, its events become visible to everyone. Our agent reads every new block, so it typically sees a sale within about a second of it happening.

### An ordering quirk we had to handle

Inside a single trade, the pool announces its new bucket sizes (**Sync**) *before* it announces the trade itself (**Swap** or **Burn**). If you read events one at a time, a normal sale briefly looks like "BNB vanished from the pool with no trade", which looks like a liquidity pull. So the agent reads each batch of events as a whole first, and only then decides.

### Public nodes can disagree

We read the chain through free public servers, and these are several machines behind one address. One machine can be a moment behind another. So the agent **re-reads the last few blocks every time** and keeps a list of events it has already handled. Nothing gets missed, and nothing gets handled twice.

---

## 4. How Ejector Seat works: the big picture

```
         ┌────────────────────────── BNB Smart Chain (testnet) ───────────────────────────┐
         │   RUGME token                      PancakeSwap pool (RUGME / BNB)              │
         │   "tokens moved"                   "trade happened", "pool changed",           │
         │                                    "liquidity removed"                         │
         └───────────────┬────────────────────────────────┬───────────────────────────────┘
                         │ events                         │ events
                         ▼                                ▼
                 ┌───────────────────────────────────────────────┐
   1. WATCH      │  Watcher: reads every new block               │
                 └───────────────────────┬───────────────────────┘
                                         ▼
                 ┌───────────────────────────────────────────────┐
   2. DECIDE     │  Rules: four fixed tripwires (T1–T4)          │  ← plain code, no AI
                 └───────────────────────┬───────────────────────┘
                                         ▼ first tripwire hit
                 ┌───────────────────────────────────────────────┐
   3. ACT        │  Executor: signs ONE pre-prepared "sell" and  │  ← plain code, no AI
                 │  sends it immediately                         │
                 └───────────────────────┬───────────────────────┘
                                         ▼
                 SafeExit contract sells the tokens on PancakeSwap
                 → the BNB goes back to the user, always

   Off to the side, not urgent:  AI risk brief before · AI explanation after · live dashboard
```

The core idea is a strict split between **urgent** and **non-urgent** work:

* **Urgent path (watch → decide → act):** plain, predictable code only. It has to be fast, and it has to behave the same way every time.
* **Non-urgent work:** the AI-written risk brief, the AI-written explanation afterwards, and the dashboard. These are nice to have, and the guard works perfectly without them.

---

## 5. Step 1 & 2: watching and deciding (the four tripwires)

The agent knows in advance which wallets belong to the team (from the pre-flight check) and which pool to watch. On every new block it checks four tripwires:

| Tripwire | Fires when… | Why it matters |
|---|---|---|
| **T1: Team sells into the pool** | A team wallet sends **≥1% of its holdings** into the pool | The classic "test sale" before a dump. This one fires in our demo. |
| **T2: Team makes a big move** | A team wallet sends **>20% of its holdings** to any address that's not on the safe list | Teams often move tokens to fresh wallets or exchanges right before dumping |
| **T3: Liquidity pull** | Over **10% of the pool's liquidity** is removed, or the pool's BNB drops more than 10% with no trade to explain it | Once liquidity is gone, nobody can sell |
| **T4: New supply minted** | New tokens appear out of nowhere | Printing tokens to sell dilutes everyone |

**The safe list** covers addresses where a team move isn't suspicious: the "burn" address (sending tokens there destroys them), and staking, vesting or locking contracts.

### Design choices behind the tripwires

* **Act on the first tripwire, once.** Waiting for "more evidence" costs exactly the seconds that matter. After ejecting, the agent keeps watching and logging (in the demo it also catches the dump and the liquidity pull), but it never sells twice.
* **The trade-off: false alarms vs. missed rugs.** Sensitive tripwires catch rugs early but sometimes fire on innocent moves. A false alarm costs the user one sale, and they can buy back in. A missed rug costs them nearly everything. For risky small tokens, we deliberately lean toward sensitive.
* **Thresholds are relative.** "1% of the team's holdings" works for a tiny token or a big one, unlike a fixed number of tokens.

---

## 6. Step 3: acting fast (the sell)

### Everything is prepared in advance

When the guard **arms**, it does all the slow work up front: it reads how many tokens it's protecting, the agent's transaction counter, and the current gas price. When a tripwire fires, all that's left is:

1. calculate a minimum acceptable price,
2. sign the sell transaction on the laptop (instant, no network needed),
3. send it in **one network call**.

In our demo the sell goes out about **0.2 seconds** after the agent sees the dev's sale. The goal was under 2 seconds.

### Why slippage is set to 15%

Every sale names a **minimum amount of BNB** it will accept. If the price moves further than that before the sale lands, the sale is cancelled. Normal traders use about 0.5–1%. We use **15%**, because during a rug the price is crashing, and a sale that gets cancelled is far worse than a sale at a slightly worse price. If the sale is cancelled anyway, the agent retries once with **no minimum at all**. Getting out matters more than getting the best price.

We also pay a bit more gas than normal, so our sale gets processed promptly.

### Why we react after the dev's sale, not before

We act once the dev's sale is **already in a block**. That's why Ejector Seat **can't beat a rug done in a single transaction**: if the team sells everything and pulls the liquidity all at once, there's no later moment to act in. We protect against the much more common multi-step rug.

---

## 7. Why it's safe: the agent can only press one button

The biggest worry with any "agent that trades for you" is: what stops it, or anyone who hacks it, from stealing the funds? Our answer is **least privilege**: the agent gets exactly one power and nothing else.

### SafeExit: a sell contract with no "send to" field

All sales go through **SafeExit**, a tiny contract we wrote. You give it tokens, it sells them on PancakeSwap, and it sends the BNB back to **whoever called it**. There's no way to tell it "send the money somewhere else". That option simply doesn't exist. So even a fully hacked agent can't redirect the proceeds.

### Two ways to let the agent press the button

**Option A: GuardedVault (our own safe box).** The user puts their tokens into a small vault contract.
* The **user** (owner) can withdraw or change the guardian.
* The **agent** (guardian) can do one thing: "eject", meaning sell everything through SafeExit. The BNB stays in the vault for the user to withdraw.
* There's no other way to move funds out.

**Option B: Altana session key (the user keeps their tokens).** The tokens never leave the user's own wallet. Using the sponsor's technology:
* **EIP-7702** lets a normal wallet temporarily take on smart-account features, while keeping the same address and the same tokens.
* The user gives the agent a **session key**: a separate key with a written, on-chain rulebook. Our rulebook says: "may only call SafeExit's sell function, on this one contract, spending at most 0.002 BNB a day on fees, and expires in 24 hours."
* Altana's account system checks every action against that rulebook and **rejects anything else**. We tested this: the session key's attempts to transfer tokens, grant approvals, or send BNB to the agent were all refused.
* A fresh session key is created on each reset, because Altana's on-chain registry only accepts each key once.

| | GuardedVault | Altana session key |
|---|---|---|
| Where the tokens sit | In our vault | In the user's own wallet |
| Who enforces the limits | Our small contract | Altana's account system plus an on-chain rulebook |
| Speed in our demo | ~1 s for the sale to land | ~5 s (goes through Altana's relay service) |
| Fees | The agent pays gas | Relay fees come from the user's wallet |
| Best for | A reliable stage demo | The real-world product story |

---

## 8. Where the AI fits, and where it never goes

### The AI is never in the urgent path

The decision to sell, and the sale itself, are made by **plain, fixed rules**. The AI is kept out for three reasons:

1. **Speed.** An AI call takes seconds, and we have about one second.
2. **Predictability.** The same situation must always produce the same decision. AI answers can vary.
3. **Manipulation.** A token's name, description and messages are written by its creator, who is the potential scammer. An AI that reads them could be tricked into "don't sell, everything is fine". Keeping the AI away from decisions and keys removes that attack completely.

The AI also **never touches a private key**.

### What the AI does do

* **Before: the risk brief.** Code works out the hard facts: how much of the supply the team holds, who holds the liquidity, whether the owner can mint, and how deep the pool is. It also gives a LOW, MEDIUM or HIGH verdict. The AI only rewrites those facts into four easy sentences.
* **After: the explanation.** Code calculates when the eject happened, why, how much BNB the user received, how far the price fell, and how much the user saved. The AI only turns that into a short, friendly message.

### A guard against made-up numbers

AIs sometimes invent figures. So we check every number in the AI's answer against the facts we gave it. If the AI writes a number that wasn't in the facts, we throw the answer away and use our own pre-written template. If there's no AI available at all, the template is used, and the demo works the same.

---

## 9. The dashboard: watching it live

The dashboard is a web page built for a projector. It shows:
* the risk brief
* a live price chart
* a **WITH EJECTOR SEAT** card and a **WITHOUT EJECTOR SEAT** card, two users who each start with the same 20,000 RUGME
* a live event log with links to every transaction on BscScan
* the output of whatever demo step is running

**How it stays live:** the agent publishes its state, and the dashboard server relays it to the page as a continuous stream of updates. The dashboard server runs separately from the agent, so the page can stay open while the agent is restarted between runs.

**The buttons** (Reset, Arm guard, Rug it, Run full demo) run the same demo steps as the terminal commands. Because the buttons spend testnet funds, the server only accepts requests from the same computer, and it checks for a secret header. That stops another website open in the same browser from pressing the buttons for you.

---

## 10. The demo world we built

To show a rug safely, we build a small one ourselves on **BSC testnet**, where the coins are free and have no real value:

| Who | Role | Holds |
|---|---|---|
| **DEPLOYER** | Sets up the scenario and funds the pool | Our testnet BNB |
| **DEV** | The "scammer" team wallet | 30% of RUGME plus all the LP tokens |
| **GUARDED** | User protected by Ejector Seat | 2% of RUGME (20,000) |
| **UNGUARDED** | Identical user with no protection | 2% of RUGME (20,000) |
| **AGENT** | Ejector Seat itself | Only enough BNB for gas |

The rest of the supply goes into the pool (15%) or is destroyed (51%). The pool is kept **small compared to DEV's bag**, so the dump crashes the price by about 90%, just like a real rug.

**Reset** tears everything down and builds a fresh token, pool and contracts in under a minute. It also pulls the pool's BNB back each time, so 0.1 test BNB lasts for dozens of runs.

### What "success" means

The **acceptance test**: after the rug, GUARDED must keep **more than half** its value and UNGUARDED must keep **less than a fifth**. Our real runs score **83.6% vs 0.1%**, consistently.

---

## 11. BNB Agent Studio: giving the agent an identity

We also packaged Ejector Seat with **BNB Agent Studio**, BNB Chain's toolkit for AI agents:

* **ERC-8004 identity:** a public, on-chain "ID card" for agents. Ours is **agent #2643**, named "Ejector Seat", so anyone can look it up and see what it is and where it lives.
* **The deployed service** runs on BNB Chain's 48-hour trial hosting and offers Ejector Seat's **risk brief** as a service other agents could use.
* **Same safety rule as our guard:** the Studio agent's AI can only *read* the chain. Anything that signs is fixed code, never something the AI can call.

The guard itself still runs on our machine, because the instant sell needs to be fast and fully under our control.

---

## 12. Limits we're honest about

* **A single-transaction rug can't be beaten.** If everything happens in one transaction, there's no moment to react in.
* **False alarms cost a sale.** A legitimate team move to an address that's not on the safe list will eject the user.
* **Team wallets must be known.** We watch the wallets we're told about. Hidden team wallets need better discovery, which is a future improvement.
* **Altana mode is slower** (about 5 s vs 1 s). That was fine in the demo, but a faster rugger could beat it.
* **Chain reorganizations:** very rarely, a block gets replaced. If our trigger was in a replaced block, the worst case is an unnecessary sale, never a loss of control over funds.
* **It's a hackathon prototype:** testnet only, unaudited contracts, free public servers, and one laptop.

---

## 13. Glossary

| Term | Meaning |
|---|---|
| **BSC / BNB Smart Chain** | The blockchain we run on. **Testnet** is the practice version with free coins. |
| **tBNB** | Testnet BNB: free, worthless, and used for fees and liquidity in our demo |
| **Token (ERC-20 / BEP-20)** | A standard digital coin contract. RUGME is ours. |
| **Wallet / address** | An account on the chain, controlled by a private key |
| **Private key** | The secret that authorizes a wallet's actions. Ours stay in a local, gitignored file. |
| **Transaction (tx)** | One signed action sent to the chain, viewable on BscScan |
| **Block** | A batch of transactions, added about every second |
| **Event / log** | A public announcement a contract makes when something happens |
| **Gas** | The fee paid to process a transaction |
| **DEX** | Decentralized exchange; PancakeSwap is the main one on BNB Chain |
| **Liquidity pool** | The two token "buckets" a DEX trades against |
| **Constant product (x·y=k)** | The rule that sets pool prices |
| **Price impact** | How much a trade moves the price; bigger trades move it more |
| **Slippage / minimum out** | The worst price a trade will accept before cancelling |
| **LP tokens** | Receipts for providing liquidity; whoever holds them can withdraw it |
| **Rug pull** | The team dumps its tokens and/or pulls the liquidity, leaving holders with nothing |
| **Mint** | Creating new tokens |
| **Smart contract** | A program on the blockchain (SafeExit, GuardedVault, RugMe) |
| **Least privilege** | Giving a system only the exact permission it needs, and nothing more |
| **EIP-7702** | A standard that lets a normal wallet use smart-account features without changing its address |
| **Session key** | A limited, expiring key that may only do what its on-chain rules allow |
| **Relay** | A service that submits transactions for a smart account (used by Altana) |
| **ERC-8004** | A standard for on-chain agent identities |
| **ERC-8183** | A standard for agents selling services on-chain with escrowed payment |
| **Deterministic** | Always gives the same output for the same input; no randomness, no AI |
