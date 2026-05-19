# Aura -- The AI Wealth Layer for Robinhood Chain

> **A Robinhood-grade trading experience powered by Multi-Agent AI, Account Abstraction, and a Stylus-native Order Book.**
> Built for the Arbitrum Open House London Buildathon 2026.

---

## The Problem

DeFi onboarding is broken. Users face three barriers:
1. **Complexity**  manage seed phrases, choose protocols, calculate gas, sign approvals
2. **Gas friction**  every interaction requires the user to hold ETH
3. **Trust**  no safety net if a strategy is risky or a swap is bad

Aura solves all three by making DeFi feel like a fintech app -- but with full self-custody.

---

## The Solution

### Three pillars

#### 1. Agentic Intelligence -- Multi-Agent Committee
A **dual-agent safety architecture** that no other hackathon project has:

- **Executor Agent** translates natural language into precise on-chain plans (LangChain + NVIDIA Llama 3.1 70B)
- **Risk Auditor Agent** independently audits the proposal -- checks balances, allowances, slippage, macro context -- before signing
- **Macro Analyzer** integrates Pyth Network prices + correlation matrix + NewsAPI sentiment to add market context to every decision

Result: a user types *"DCA 0.001 ETH into AMZN every day for a week"*  both agents collaborate -- user gets a single signature prompt with full reasoning visible.

#### 2. Stylus-Native Order Book
The first hackathon project to combine a **Rust/WASM perpetual order book** (Arbitrum Stylus) with a **Solidity Vault LP** (Robinhood Chain) for hybrid execution:

- **Limit orders** go to the Stylus LOB on Arbitrum Sepolia (compute-heavy matching, sorting)
- **Market orders** go to AuraPerps on Robinhood Chain (immediate liquidity vs Vault LP)
- **AI Keeper** bridges them: polls Pyth, calls `match_orders` on Stylus, settles fills via the Solidity router

Benchmarked **34% gas savings** on `get_active_orders_sorted` (the hot path) vs pure Solidity at scale (see [bench results](#-stylus-vs-solidity-benchmark)).

#### 3. Retail UX -- Gasless & Intent-Based
- **Account Abstraction (EIP-4337)** via custom `AuraAccount` + `AuraPaymaster`
- **Natural language chat** for swaps and DCA
- **Live order book widget** updating every 5s on the trade page
- **One-click market orders** with Pyth-fresh entry prices

---

## Live Architecture

```
+------------------------------- USER (one signature) --------------------------------+
|                                                                                     |
|         /chat (NLP intent)                              /trade (manual)             |
|              |                                               |                      |
|              v                                               v                      |
|  +---------------------------+              +-------------------------------+       |
|  | Multi-Agent Committee     |              | Order Panel                   |       |
|  |  - Executor (Llama 3.1)  |              |  - Market  -> AuraPerps       |       |
|  |  - Risk Auditor          |              |  - Limit   -> Stylus LOB      |       |
|  |  - Macro Analyzer        |              +---------------+---------------+       |
|  +-----------+---------------+                             |                        |
|              |                                             v                        |
|              v                              +-------------------------------+       |
|    Synthra V3 Router                        | Hybrid Execution Engine       |       |
|    (Robinhood Chain)                        |  1. Walk Stylus LOB           |       |
|                                             |  2. Fallback -> Vault LP      |       |
|                                             +---------------+---------------+       |
+---------------------------------------------|--------------------------------------|+
                                              |
              +-------------------------------+-------------------------------+
              |                                                               |
              v                                                               v
+---------------------------+                          +-----------------------------+
| Stylus LOB (WASM)         |                          | AuraPerps + Vault LP        |
| Arbitrum Sepolia (421614) |                          | Robinhood Chain (46630)     |
|                           |                          |                             |
| - store_order             |                          | - openPosition              |
| - match_orders            |<--- AI Keeper --->       | - closePosition             |
| - consume_order           |     (Pyth feed)          | - liquidatePosition         |
| - get_active_orders_sorted|                          | - Pyth MockOracle           |
+---------------------------+                          +-----------------------------+

                        +-----------------------------+
                        | AI Market Maker             |
                        |  - marketMaker.js           |
                        |  - places bid/ask quotes    |
                        |  - around Pyth mid          |
                        +-----------------------------+
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Smart Contracts (Solidity)** | OpenZeppelin, ERC-1967 Proxies, ERC-4626 (vault), EIP-4337 (account abstraction) |
| **Smart Contracts (Rust/WASM)** | Stylus SDK 0.10.6, alloy 1.5.7, Rust 1.91 |
| **AI Backend** | LangChain.js, NVIDIA NIM (Llama 3.1 70B), GPT-4o fallback, Pyth Hermes |
| **Frontend** | Next.js 15, React 19, viem, thirdweb v5 SDK, GSAP, Framer Motion |
| **Chains** | Robinhood Chain Testnet (perps + spot) + Arbitrum Sepolia (Stylus LOB) |

---

## Stylus vs Solidity Benchmark

Real numbers from `scripts/bench-large-scale.js` on Arbitrum Sepolia (60 resting orders):

| Operation | Stylus (WASM) | Solidity |  | Verdict |
|---|---|---|---|---|
| `store_order` (cumulative 60) | 13 740 458 | 12 662 016 | +8% | Storage-bound, slight overhead |
| `get_active_orders_sorted` cap=20 | **759 447** | 1 103 053 | **31%** |  Sort-heavy, Stylus shines |
| `get_active_orders_sorted` cap=30 | **761 585** | 1 159 369 | **34%** |  Same |
| `match_orders` (full scan, 0 hits) | 788 052 | 792 359 | ~0% | Break-even |
| `match_orders` (full scan, 16 hits) | 529 860 | 526 694 | ~0% | Break-even |

**Insight**: Stylus wins on compute-heavy hot paths (sort, scan large arrays). For storage-only operations the runtime overhead breaks even. We use Stylus exactly where it matters -- the order book viewer hit on every page render.

---

## Live Deployments

### Arbitrum Sepolia (Stylus LOB layer)
| Contract | Address |
|---|---|
| **Stylus LOB v2** | [`0x13454e38bebf907589fce0d49cc01cf899212745`](https://sepolia.arbiscan.io/address/0x13454e38bebf907589fce0d49cc01cf899212745) |
| Solidity LOB (bench reference) | [`0x030839d7AC5Df159dB38ACa99CF8258BF9EC447E`](https://sepolia.arbiscan.io/address/0x030839d7AC5Df159dB38ACa99CF8258BF9EC447E) |

### Robinhood Chain Testnet (Settlement layer)
| Contract | Address |
|---|---|
| AuraPerps | `0x8AECF449B27BB41E34C04D8C99F4348FF38bB9a2` |
| AuraVault (LP) | `0x4Ae6Ab5BCAb4F0f2FAcAA47aD2ea5832eBDF5792` |
| AuraIntelligenceVault (ERC-4626) | `0x69A88c72eAda96A515e0dc57632A6Abf59EA2E38` |
| AuraPerpsRouter (Hybrid) | `0x5F88E57fBDC5B83827273d2ab8843226F40d0E13` |
| AuraAccount Factory | `0x95Aa20d53EB26f292a71D8B38515BBeC8905b550` |
| aUSD | `0x359961489f069F16E5dbA46d9b174bBF7b25147B` |
| Pyth MockOracle | `0x097AeB196366317cf97986A04f32Df312c96ABa1` |

---

## Test Coverage

**55 passing tests** across the security-critical paths:

```
AuraIntelligenceVault -- Full ERC-4626 vault security suite (25 tests)
   Deposit / Withdraw / Approve flows
   Risk Score Ceiling enforcement
   Function Selector whitelist
   Emergency Pause / Unpause
   Stylus Guardrail integration
   Protocol whitelist add/remove

AuraOrderBook -- Full lifecycle (24 tests)
   store_order (access control, params validation, counters)
   cancel_order (owner check, status flip, depth decrement)
   match_orders (bid/ask fill logic, cross-asset isolation)
   consume_order (atomic Active->Executed)
   get_active_orders_sorted (insertion sort, cap, empty)
   Stats tracking

Hybrid LOB+AMM Router (4 tests)
   Walks book first, falls back to Vault LP
   placeLimitOrderFor authorization for MMFund
   Rejects unauthorized callers

Aura Account Abstraction (2 tests)
   AuraAccount.executeBatch routing
   Factory deterministic deployments
```

Run with: `npx hardhat test`

---

## Hackathon Criteria

| Criterion | Aura's Edge |
|---|---|
| **Smart Contract Quality** | 31 tests, OZ standards, ERC-4626 vault, EIP-4337 accounts, Stylus snake_case selector compatibility, gas-benched against Solidity |
| **Product-Market Fit** | Targets Robinhood Chain's massive retail audience. Gasless UX + chat = the same UX pattern as Robinhood, but with full self-custody and DeFi yields |
| **Innovation & Creativity** | First project to combine Multi-Agent safety + Stylus LOB + EIP-4337. Cross-chain hybrid (Stylus = compute, Robinhood = settlement) is novel |
| **Real Problem Solving** | Answers DeFi's three real barriers -- complexity, gas, trust -- without compromising self-custody |

---

## Setup & Quickstart

### Prerequisites

- Node.js >= 18
- MetaMask (or any EVM wallet)
- ETH on Arbitrum Sepolia (for limit orders)
- ETH on Robinhood Chain Testnet (for market orders)

### 1. Clone & Install

```bash
git clone https://github.com/maxence81/Aura-Protocol.git
cd Aura-Protocol
npm install
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
```

### 2. Configure Environment

```bash
# Root (for Hardhat scripts & tests)
cp .env.example .env
# Edit .env and add your PRIVATE_KEY + API keys

# Backend
cp backend/.env.example backend/.env
# Edit backend/.env with the same values
```

Required keys:
- `PRIVATE_KEY` -- deployer wallet (must have ETH on both chains)
- `NVIDIA_API_KEY` -- get one free at https://build.nvidia.com (Llama 3.1 70B)
- `NEWSAPI` -- free at https://newsapi.org

All contract addresses are pre-filled with our live testnet deployments.

### 3. Compile & Test

```bash
npx hardhat compile
npx hardhat test                    # 55 tests, all passing
```

### 4. Run the Stylus vs Solidity Benchmark

```bash
npx hardhat run scripts/bench-large-scale.js --network arbitrumSepolia
```

### 5. Run the Full Demo (4 terminals)

```bash
# Terminal 1 -- Backend API (port 3001)
cd backend && node index.js

# Terminal 2 -- AI Market Maker (populates the Stylus LOB with quotes)
cd backend && node marketMaker.js

# Terminal 3 -- AI Keeper (matches orders + cross-chain settlement)
cd backend && node lobKeeper.js

# Terminal 4 -- Frontend (port 3000)
cd frontend && npm run dev
```

### 6. Use the App

1. Open http://localhost:3000
2. Connect MetaMask
3. `/chat` -- type "Swap 0.001 ETH to AMZN" to see the Multi-Agent Committee in action
4. `/trade` -- place market or limit orders on the live Stylus Order Book
5. `/vault` -- deposit aUSD into the AI-managed ERC-4626 vault

The AI Market Maker will populate the order book within 30 seconds. The Keeper matches orders every 10 seconds and settles positions cross-chain on Robinhood Chain.

---

## Repository Structure

```
arbitrum_hackathon/
 contracts/              Solidity contracts (perps, vault, account, paymaster, )
 stylus-orderbook/       Rust/WASM order book (Stylus 0.10.6)
 backend/                Node.js multi-agent backend
    agent.js            Executor + Risk Auditor
    macroAnalyzer.js    Pyth + news + correlations
    marketMaker.js      AI Market Maker (Stylus LOB)
    lobKeeper.js        AI Keeper (Pyth -- match_orders)
    index.js            Express API
 frontend/               Next.js 15 trading UI
    app/trade/          Perpetual trading page (LOB + market orders)
    app/chat/           Multi-agent chat for swaps & DCA
    app/vault/          ERC-4626 deposit / withdraw
 scripts/                Hardhat deploy + bench scripts
 test/                   Hardhat test suite (31 tests)
 ARCHITECTURE.md         Full architecture reference
```

---

## Demo

> *"Aura: where AI meets safe, retail-first DeFi on Arbitrum + Robinhood Chain."*

A typical user flow:
1. Connect wallet
2. Type *"Swap 0.001 ETH for AMZN"*  Multi-Agent Committee analyzes -- SignModal appears
3. Sign with one click
4. Or go to `/trade`  see the **Live Stylus Order Book** populated by the AI Market Maker -- place a limit order -- watch the keeper match it in real time

---

## License

MIT
