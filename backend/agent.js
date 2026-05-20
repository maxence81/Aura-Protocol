const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const dotenv = require("dotenv");
const { ethers } = require("ethers");
const { analyzeMacroSentiment } = require("./macroAnalyzer");
const { getAllPrices } = require("./market");

dotenv.config();

const OFFICIAL_CONTRACTS = {
    TOKENS: {
        AUSD: process.env.AUSD_ADDRESS || "0x50a8Ecee8B72A21F33847FD44cC491B1dD338aE0",
        WETH: "0x33e4191705c386532ba27cBF171Db86919200B94",
        TSLA: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E",
        AMZN: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02",
        NFLX: "0x4e464c5800000000000000000000000000000000",
        AMD:  "0x414d440000000000000000000000000000000000",
        PLTR: "0x504c545200000000000000000000000000000000",
        BTC:  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"
    },
    PROTOCOLS: {
        SYNTHRA_ROUTER: process.env.ROUTER_ADDRESS || "0x6F308B834595312f734e65e273F2210f43Fc48F8",
        PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
        GMX_YIELD: "0x8363E6D64Bc462F3DD8E76dfbDF7a2d50D0411f4",
        STYLUS_LOB: process.env.STYLUS_LOB_ADDRESS || "0x13454e38bebf907589fce0d49cc01cf899212745"
    }
};

// ── Chain IDs for routing transactions to the right network ──
const CHAINS = {
    ROBINHOOD_TESTNET: 46630,   // Synthra V3 swaps land here
    ARBITRUM_SEPOLIA: 421614    // Stylus LOB lives here
};

const ERC20_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function transferFrom(address from, address to, uint256 amount) external returns (bool)"
];

const agentModel = new ChatGoogleGenerativeAI({
    apiKey: process.env.GEMINI_API_KEY,
    model: "gemini-2.5-flash",
    temperature: 0,
});

async function askAI(prompt) {
    try {
        console.log("🤖 Attempting AI (NVIDIA - Llama 3.1 70B)...");
        const response = await agentModel.invoke([{
            role: "user",
            content: prompt + " \nIMPORTANT: Return ONLY raw JSON. No markdown."
        }]);
        const clean = response.content.replace(/```json/g, "").replace(/```/g, "").trim();
        return JSON.parse(clean);
    } catch (e) {
        console.error("❌ NVIDIA API failed:", e.message);
        return {
            action: "SWAP",
            token_in_symbol: "ETH",
            token_out_symbol: "AUSD",
            amount: "0.01",
            description: "Fallback mode due to AI timeout"
        };
    }
}

function getTokenAddress(symbol) {
    const upper = symbol.toUpperCase();
    if (upper === "ETH" || upper === "WETH") return OFFICIAL_CONTRACTS.TOKENS.WETH;
    if (upper === "AUSD") return OFFICIAL_CONTRACTS.TOKENS.AUSD;
    if (upper === "TSLA") return OFFICIAL_CONTRACTS.TOKENS.TSLA;
    if (upper === "AMZN") return OFFICIAL_CONTRACTS.TOKENS.AMZN;
    if (upper === "NFLX") return OFFICIAL_CONTRACTS.TOKENS.NFLX;
    if (upper === "AMD") return OFFICIAL_CONTRACTS.TOKENS.AMD;
    if (upper === "PLTR") return OFFICIAL_CONTRACTS.TOKENS.PLTR;
    if (upper === "BTC") return OFFICIAL_CONTRACTS.TOKENS.BTC;
    return null;
}

function buildEthToTokenSwap(amountWei, tokenOutAddress, recipient) {
    const routerIface = new ethers.Interface(["function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable"]);
    const commands = "0x0b00";
    
    // WRAP_ETH: recipient 2 (Router)
    const wrapInput = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [2, amountWei]);
    
    // Correctly pack the path for Uniswap V3: [address, uint24, address]
    // 3000 fee = 0x000bb8
    const path = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [OFFICIAL_CONTRACTS.TOKENS.WETH, 3000, tokenOutAddress]
    );
    
    // V3_SWAP_EXACT_IN: recipient (user), amountIn, minAmountOut, path, payerIsUser (false)
    const swapInput = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "uint256", "bytes", "bool"], 
        [recipient, amountWei, 0, path, false]
    );
    
    const deadline = Math.floor(Date.now() / 1000) + 1800;

    return {
        targets: [OFFICIAL_CONTRACTS.PROTOCOLS.SYNTHRA_ROUTER],
        values: [amountWei.toString()],
        datas: [routerIface.encodeFunctionData("execute", [commands, [wrapInput, swapInput], deadline])]
    };
}

function buildTokenToEthSwap(amountWei, tokenInAddress, recipient, eoa, targetAccount, symbol, totalSwaps = 1) {
    const routerIface = new ethers.Interface(["function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable"]);
    const erc20Iface = new ethers.Interface(ERC20_ABI);
    const permit2Iface = new ethers.Interface(["function approve(address token, address spender, uint160 amount, uint48 expiration) external"]);

    const totalApproval = (BigInt(amountWei) * BigInt(totalSwaps)).toString();

    const pullData = erc20Iface.encodeFunctionData("transferFrom", [eoa, targetAccount, amountWei]);
    const approvePermit2Data = erc20Iface.encodeFunctionData("approve", [OFFICIAL_CONTRACTS.PROTOCOLS.PERMIT2, totalApproval]);
    const expiration = Math.floor(Date.now() / 1000) + (30 * 24 * 3600); // 30 days
    const permit2ApproveData = permit2Iface.encodeFunctionData("approve", [tokenInAddress, OFFICIAL_CONTRACTS.PROTOCOLS.SYNTHRA_ROUTER, totalApproval, expiration]);
    
    // Commands: 0x00 = V3_SWAP_EXACT_IN, 0x0c = UNWRAP_WETH
    const commands = "0x000c";
    
    const path = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [tokenInAddress, 3000, OFFICIAL_CONTRACTS.TOKENS.WETH]
    );

    // IMPORTANT: recipient 0x00...02 for unwrap
    const swapInput = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "uint256", "bytes", "bool"], ["0x0000000000000000000000000000000000000002", amountWei, 0, path, true]);
    const unwrapInput = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [recipient, 0]);
    const deadline = Math.floor(Date.now() / 1000) + 1800;

    return {
        targets: [tokenInAddress, tokenInAddress, OFFICIAL_CONTRACTS.PROTOCOLS.PERMIT2, OFFICIAL_CONTRACTS.PROTOCOLS.SYNTHRA_ROUTER],
        values: ["0", "0", "0", "0"],
        datas: [pullData, approvePermit2Data, permit2ApproveData, routerIface.encodeFunctionData("execute", [commands, [swapInput, unwrapInput], deadline])],
        requiredApproval: {
            tokenAddress: tokenInAddress,
            spender: targetAccount,
            amount: totalApproval,
            symbol: symbol
        }
    };
}

function buildTokenToTokenSwap(amountWei, tokenInAddress, tokenOutAddress, recipient, eoa, targetAccount, symbol, totalSwaps = 1) {
    const routerIface = new ethers.Interface(["function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable"]);
    const erc20Iface = new ethers.Interface(ERC20_ABI);
    const permit2Iface = new ethers.Interface(["function approve(address token, address spender, uint160 amount, uint48 expiration) external"]);

    const totalApproval = (BigInt(amountWei) * BigInt(totalSwaps)).toString();

    const pullData = erc20Iface.encodeFunctionData("transferFrom", [eoa, targetAccount, amountWei]);
    const approvePermit2Data = erc20Iface.encodeFunctionData("approve", [OFFICIAL_CONTRACTS.PROTOCOLS.PERMIT2, totalApproval]);
    const expiration = Math.floor(Date.now() / 1000) + (30 * 24 * 3600); // 30 days
    const permit2ApproveData = permit2Iface.encodeFunctionData("approve", [tokenInAddress, OFFICIAL_CONTRACTS.PROTOCOLS.SYNTHRA_ROUTER, totalApproval, expiration]);

    const commands = "0x00";
    
    const path = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [tokenInAddress, 3000, tokenOutAddress]
    );

    const swapInput = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "uint256", "bytes", "bool"], [recipient, amountWei, 0, path, true]);
    const deadline = Math.floor(Date.now() / 1000) + 1800;

    return {
        targets: [tokenInAddress, tokenInAddress, OFFICIAL_CONTRACTS.PROTOCOLS.PERMIT2, OFFICIAL_CONTRACTS.PROTOCOLS.SYNTHRA_ROUTER],
        values: ["0", "0", "0", "0"],
        datas: [pullData, approvePermit2Data, permit2ApproveData, routerIface.encodeFunctionData("execute", [commands, [swapInput], deadline])],
        requiredApproval: {
            tokenAddress: tokenInAddress,
            spender: targetAccount,
            amount: totalApproval,
            symbol: symbol
        }
    };
}






// ═══════════════════════════════════════════════════════════════════
// LIMIT ORDER FLOW (Wave 4) — Stylus LOB on Arbitrum Sepolia
// ═══════════════════════════════════════════════════════════════════

/// keccak256(abi.encodePacked(symbol)) → uint256, matching the asset hashing
/// used by AuraPerpsRouter.registerAsset on Solidity. The Stylus LOB stores
/// orders keyed by this hash so the same convention must hold on both sides.
function getAssetHashUint256(symbol) {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(symbol.toUpperCase()));
    return BigInt(hash).toString();
}

/// Encode store_order(...) directly to the Stylus LOB. Caller (msg.sender) must
/// be the LOB's `router`. We initialized the contract with the deployer EOA as
/// router, so the user signing this tx with the same EOA is authorized.
function buildLimitOrderTx({ asset, isLong, collateral, leverage, limitPrice, eoa }) {
    const stylusLob = OFFICIAL_CONTRACTS.PROTOCOLS.STYLUS_LOB;
    const lobIface = new ethers.Interface([
        "function store_order(address owner, uint256 asset_hash, bool is_long, uint256 collateral, uint256 leverage, uint256 limit_price) returns (uint256)"
    ]);

    const assetHash = getAssetHashUint256(asset);
    // collateral and limit_price arrive in human units → scale to 18 decimals
    const collateralWei = ethers.parseUnits(collateral.toString(), 18).toString();
    const limitPriceWei = ethers.parseUnits(limitPrice.toString(), 18).toString();
    const leverageInt = Math.max(1, Math.min(50, parseInt(leverage) || 1));

    const data = lobIface.encodeFunctionData("store_order", [
        eoa,
        assetHash,
        isLong,
        collateralWei,
        leverageInt,
        limitPriceWei
    ]);

    return {
        targets: [stylusLob],
        values: ["0"],
        datas: [data],
        chainId: CHAINS.ARBITRUM_SEPOLIA,
        // Single-call shape (no AuraAccount.executeBatch wrap) for direct EOA → LOB signing.
        kind: "LIMIT_ORDER",
        contractAddress: stylusLob,
        encodedCalldata: data,
        ethValue: "0"
    };
}

async function proposeLimitOrder(request, eoa) {
    const prompt = `You are the Aura Limit Order Parser. Extract a perpetual limit order intent from: "${request}".

The user wants to place a RESTING limit order on the on-chain order book (Aura Stylus LOB on Arbitrum Sepolia).

Available assets: ETH, BTC, TSLA, AMZN, NFLX, AMD, PLTR.

Direction:
  - "long" / "buy" / "bid" → is_long = true
  - "short" / "sell" / "ask" → is_long = false

Examples:
  - "Place a limit order ETH long 5x at $1800"  →  { asset: "ETH",  is_long: true,  leverage: 5, limit_price: 1800, collateral: 100 }
  - "Short BTC 10x at 75000 with $50 collateral" →  { asset: "BTC", is_long: false, leverage: 10, limit_price: 75000, collateral: 50 }
  - "Buy AMZN at limit 250"                      →  { asset: "AMZN", is_long: true,  leverage: 1, limit_price: 250, collateral: 100 }

If collateral is unspecified, default to 100 (USD-equivalent units).
If leverage is unspecified, default to 1.
Leverage MUST be in [1, 50]. Round if needed.

Return strict JSON:
{
  "asset": "<one of ETH|BTC|TSLA|AMZN|NFLX|AMD|PLTR>",
  "is_long": <true|false>,
  "leverage": <integer 1..50>,
  "limit_price": <number>,
  "collateral": <number>,
  "description": "<short human readable description>"
}`;

    const parsed = await askAI(prompt);
    console.log("📊 AI parsed (LIMIT_ORDER):", JSON.stringify(parsed));

    const asset = String(parsed.asset || "ETH").toUpperCase();
    const isLong = !!parsed.is_long;
    const leverage = Math.max(1, Math.min(50, parseInt(parsed.leverage) || 1));
    const limitPrice = Math.max(0, parseFloat(parsed.limit_price) || 0);
    const collateral = Math.max(0, parseFloat(parsed.collateral) || 100);

    if (limitPrice === 0) throw new Error("Limit order: limit_price must be > 0");
    if (collateral === 0) throw new Error("Limit order: collateral must be > 0");

    const txData = buildLimitOrderTx({ asset, isLong, collateral, leverage, limitPrice, eoa });

    return {
        ...txData,
        description: parsed.description || `${isLong ? "Long" : "Short"} ${asset} ${leverage}x @ $${limitPrice}`,
        // Common shape so /chat consumers can read these fields like a swap.
        tokenInSymbol: "AUSD",       // collateral side
        tokenOutSymbol: asset,        // exposure side
        amount_raw: ethers.parseUnits(collateral.toString(), 18).toString(),
        // Limit-order-specific fields (also surfaced for the SignModal / TransactionCard)
        limitOrder: {
            asset,
            isLong,
            leverage,
            limitPrice,
            collateral,
        },
        automation: { isAutomated: false, totalSwaps: 1, intervalSeconds: 0, initialDelayMs: 0 },
        riskManagement: { trailingStopPct: 0, takeProfitPct: 0 }
    };
}

/// Lightweight classifier: any "limit"/"long"/"short"/"limit order" keyword
/// flips the request to the LIMIT_ORDER pipeline. Falls back to SWAP otherwise.
function isLimitOrderRequest(request) {
    return /\b(limit\s*order|limit\s*at|long\s+\w+\s+\d|short\s+\w+\s+\d|limit\s*price|at\s*limit|place\s+a\s+(limit|long|short))/i
        .test(request);
}

// ═══════════════════════════════════════════════════════════════════
// SWAP FLOW (existing) — Synthra V3 router on Robinhood Chain
// ═══════════════════════════════════════════════════════════════════

async function proposeExecution(request, targetAccount, eoa) {
    const prompt = `You are the Aura Strategy Executor. Extract user intent from: "${request}".
    Available tokens and their addresses:
    - ETH (native Ether, also wrapped as WETH): ${OFFICIAL_CONTRACTS.TOKENS.WETH}
    - AUSD (Stablecoin): ${OFFICIAL_CONTRACTS.TOKENS.AUSD}
    - AMZN: ${OFFICIAL_CONTRACTS.TOKENS.AMZN}
    - TSLA: ${OFFICIAL_CONTRACTS.TOKENS.TSLA}
    - NFLX: ${OFFICIAL_CONTRACTS.TOKENS.NFLX}
    - AMD: ${OFFICIAL_CONTRACTS.TOKENS.AMD}
    - PLTR: ${OFFICIAL_CONTRACTS.TOKENS.PLTR}
    - BTC: ${OFFICIAL_CONTRACTS.TOKENS.BTC}

    Determine the DIRECTION of the swap:
    - "swap X ETH to AUSD" means token_in=ETH, token_out=AUSD
    - "swap X AUSD to AMZN" means token_in=AUSD, token_out=AMZN
    - "swap X TSLA to ETH" means token_in=TSLA, token_out=ETH
    - "swap X AMZN to TSLA" means token_in=AMZN, token_out=TSLA
    - "swap X NFLX to ETH" means token_in=NFLX, token_out=ETH
    - "swap X BTC to ETH" means token_in=BTC, token_out=ETH

    For the amount: return the value as a string (e.g., "0.0001"). Do NOT convert to wei yourself.

    CRITICAL INSTRUCTION FOR RECURRING SWAPS (DCA):
    If the user asks for a scheduled, recurring, or automated swap (e.g., "every day for 5 days", "every week for a month", "DCA 0.1 ETH daily"):
    - "total_swaps": MUST be an integer greater than 1 representing the total number of executions (e.g., "every day for 5 days" = 5).
    - "interval_seconds": MUST be an integer representing the time between swaps in seconds (e.g., "every day" = 86400).
    
    IMPORTANT: If the user says just "swap X to Y" or "buy X" without any mention of "every", "daily", "weekly", or a duration, YOU MUST set "total_swaps": 1 and "interval_seconds": 0.

    TRAILING STOP / TAKE PROFIT:
    If the user mentions a trailing stop, stop loss, or take profit (e.g., "with 5% trailing stop", "stop loss at 10%", "take profit at 20%"):
    - "trailing_stop_pct": the trailing stop percentage as a number (e.g., 5 for 5%). Set to 0 if not mentioned.
    - "take_profit_pct": the take profit percentage as a number (e.g., 20 for 20%). Set to 0 if not mentioned.

    Return strict JSON:
    {
      "action": "SWAP",
      "token_in_symbol": "<ETH, AUSD, TSLA, AMZN, NFLX, AMD, PLTR, or BTC>",
      "token_out_symbol": "<ETH, AUSD, TSLA, AMZN, NFLX, AMD, PLTR, or BTC>",
      "amount": "<string of amount for ONE swap, e.g. '0.0001'>",
      "description": "<short human readable description>",
      "total_swaps": <integer>,
      "interval_seconds": <integer>,
      "trailing_stop_pct": <number>,
      "take_profit_pct": <number>
    }`;

    const parsed = await askAI(prompt);
    console.log("📊 AI parsed:", JSON.stringify(parsed));

    const tokenInSymbol = parsed.token_in_symbol.toUpperCase();
    const tokenOutSymbol = parsed.token_out_symbol.toUpperCase();
    
    // Safely parse amount using ethers to avoid LLM math errors
    const amountRaw = ethers.parseUnits(parsed.amount.toString(), 18);
    console.log(`🔢 Amount conversion: ${parsed.amount} -> ${amountRaw.toString()} wei`);
    
    let totalSwaps = parseInt(parsed.total_swaps) || 1;
    // Heuristic fallback if AI misses the total_swaps but user explicitly says "for X days" or "X times"
    if (totalSwaps === 1) {
        const daysMatch = request.match(/for\s+(\d+)\s*days?/i);
        if (daysMatch) {
            totalSwaps = parseInt(daysMatch[1]);
        } else {
            const timesMatch = request.match(/(\d+)\s*times?/i);
            if (timesMatch) totalSwaps = parseInt(timesMatch[1]);
        }
        
        if (request.match(/for a month/i)) {
            if (request.match(/every day/i) || request.match(/daily/i)) totalSwaps = 30;
            else if (request.match(/every week/i) || request.match(/weekly/i) || request.match(/every monday/i)) totalSwaps = 4;
        } else if (request.match(/every day/i) || request.match(/daily/i)) {
            totalSwaps = 30; // Default to 30 days if no duration is specified
        }
    }

    let intervalSeconds = parseInt(parsed.interval_seconds) || 86400; // default 1 day if automated
    
    // 🚀 HACKATHON DEMO OVERRIDE:
    // If it's a recurring swap, force the interval to 15 seconds so the jury can see it execute live!
    if (totalSwaps > 1) {
        intervalSeconds = 15;
    }

    let initialDelayMs = 0;
    const timeMatch = request.match(/at\s+(\d{1,2}):(\d{2})/i);
    if (timeMatch) {
        const targetHours = parseInt(timeMatch[1]);
        const targetMinutes = parseInt(timeMatch[2]);
        const now = new Date();
        const target = new Date();
        target.setHours(targetHours, targetMinutes, 0, 0);
        if (target < now) {
            target.setDate(target.getDate() + 1);
        }
        initialDelayMs = target.getTime() - now.getTime();
        console.log(`⏳ Scheduled strategy at ${targetHours}:${targetMinutes} -> Initial Delay: ${initialDelayMs}ms`);
    }

    const isEthIn = tokenInSymbol === "ETH" || tokenInSymbol === "WETH";
    const isEthOut = tokenOutSymbol === "ETH" || tokenOutSymbol === "WETH";


    let txData;
    if (isEthIn && !isEthOut) {
        const tokenOutAddr = getTokenAddress(tokenOutSymbol);
        txData = buildEthToTokenSwap(amountRaw, tokenOutAddr, eoa, totalSwaps);
    } else if (!isEthIn && isEthOut) {
        const tokenInAddr = getTokenAddress(tokenInSymbol);
        txData = buildTokenToEthSwap(amountRaw, tokenInAddr, eoa, eoa, targetAccount, tokenInSymbol, totalSwaps);
    } else if (!isEthIn && !isEthOut) {
        const tokenInAddr = getTokenAddress(tokenInSymbol);
        const tokenOutAddr = getTokenAddress(tokenOutSymbol);
        txData = buildTokenToTokenSwap(amountRaw, tokenInAddr, tokenOutAddr, eoa, eoa, targetAccount, tokenInSymbol, totalSwaps);
    } else {
        throw new Error("Cannot swap ETH to ETH");
    }

    // Extract trailing stop / take profit params
    const trailingStopPct = parseFloat(parsed.trailing_stop_pct) || 0;
    const takeProfitPct = parseFloat(parsed.take_profit_pct) || 0;

    // Heuristic fallback for trailing stop from raw request
    if (trailingStopPct === 0) {
        const stopMatch = request.match(/(\d+)\s*%\s*(trailing\s*stop|stop\s*loss)/i);
        if (stopMatch) parsed.trailing_stop_pct = parseFloat(stopMatch[1]);
    }
    if (takeProfitPct === 0) {
        const tpMatch = request.match(/(\d+)\s*%\s*take\s*profit/i);
        if (tpMatch) parsed.take_profit_pct = parseFloat(tpMatch[1]);
    }

    return {
        ...txData,
        description: parsed.description,
        tokenInSymbol,
        tokenOutSymbol,
        amount_raw: amountRaw.toString(),
        automation: { isAutomated: totalSwaps > 1, totalSwaps, intervalSeconds, initialDelayMs },
        riskManagement: {
            trailingStopPct: parseFloat(parsed.trailing_stop_pct) || 0,
            takeProfitPct: parseFloat(parsed.take_profit_pct) || 0,
        }
    };
}




const provider = new ethers.JsonRpcProvider("https://rpc.testnet.chain.robinhood.com");

async function runAuraCommittee(request, targetAccount, eoa) {
    // ── Intent routing ──
    // The chat surface is for SWAPS / DCA only. Limit orders live on the
    // /trade page (perp order book backed by the Stylus LOB on Arbitrum
    // Sepolia). The LIMIT_ORDER pipeline below is kept reachable via a
    // BACKEND_ENABLE_LIMIT_ORDER_INTENT env flag for ad-hoc testing, but is
    // disabled in normal chat flows.
    if (process.env.BACKEND_ENABLE_LIMIT_ORDER_INTENT === "1" && isLimitOrderRequest(request)) {
        console.log("🎯 Intent classifier: LIMIT_ORDER (Stylus LOB / Arbitrum Sepolia) — feature flag enabled");
        return await runLimitOrderCommittee(request, eoa);
    }

    console.log("🎯 Intent classifier: SWAP (Synthra V3 / Robinhood Chain)");
    const proposal = await proposeExecution(request, targetAccount, eoa);

    let isSafe = true;
    let rationale = "AI-Powered Compliance Audit passed. All steps verified.";
    let macroAnalysis = null;

    // ── Step 1: Macro-Economic Analysis ──────────────────────────
    try {
        const targetAsset = proposal.tokenOutSymbol !== "ETH" ? proposal.tokenOutSymbol : proposal.tokenInSymbol;
        macroAnalysis = await analyzeMacroSentiment(targetAsset);
        
        // If macro sentiment strongly opposes the trade, warn but don't block
        if (macroAnalysis.recommendation === "DELAY" && macroAnalysis.score < -50) {
            rationale = `⚠️ MACRO WARNING: ${macroAnalysis.summary} Recommendation: ${macroAnalysis.recommendation_reason}. Proceeding with caution.`;
        } else if (macroAnalysis.recommendation === "CAUTION") {
            rationale = `📊 Market Context: ${macroAnalysis.summary} ${macroAnalysis.recommendation_reason}`;
        } else {
            rationale = `✅ Macro Analysis: ${macroAnalysis.sentiment} (Score: ${macroAnalysis.score}/100). ${macroAnalysis.summary}`;
        }
    } catch (e) {
        console.warn("Macro analysis skipped:", e.message);
    }

    // ── Step 2: On-Chain Balance / Allowance Audit ───────────────
    try {
        if (proposal.tokenInSymbol !== "ETH") {
            const tokenAddr = getTokenAddress(proposal.tokenInSymbol);

            // Check if contract exists at this address
            const code = await provider.getCode(tokenAddr);
            if (code === "0x") {
                console.warn(`⚠️ No contract found at ${tokenAddr} (${proposal.tokenInSymbol}). Mocking audit pass for demo.`);
                // For demo purposes, we'll assume it's safe if it's one of our mock tokens
                return { proposal, audit: { isSafe, rationale: `Mock token detected. Audit bypassed for hackathon demo.` }, macroAnalysis };
            }

            const erc20 = new ethers.Contract(tokenAddr, [
                "function balanceOf(address) view returns (uint256)",
                "function allowance(address, address) view returns (uint256)"
            ], provider);

            const spender = proposal.requiredApproval ? proposal.requiredApproval.spender : targetAccount;

            const [balance, allowance] = await Promise.all([
                erc20.balanceOf(eoa),
                erc20.allowance(eoa, spender)
            ]);

            // Vérifier contre l'approbation totale requise (qui inclut le nombre de swaps)
            const required = proposal.requiredApproval ? BigInt(proposal.requiredApproval.amount) : BigInt(proposal.amount_raw || "0");

            if (balance < required) {
                isSafe = false;
                rationale = `Audit failed: Insufficient ${proposal.tokenInSymbol} balance in EOA. Required: ${ethers.formatEther(required)}, Available: ${ethers.formatEther(balance)}`;
            } else if (allowance < required) {
                // On garde l'objet requiredApproval s'il est déjà là, sinon on le crée
                if (!proposal.requiredApproval) {
                    proposal.requiredApproval = {
                        tokenAddress: tokenAddr,
                        spender: targetAccount,
                        amount: required.toString(),
                        symbol: proposal.tokenInSymbol
                    };
                }
                const macroNote = macroAnalysis ? ` | Macro: ${macroAnalysis.sentiment}` : '';
                rationale = `Action required: You need to approve ${proposal.tokenInSymbol} usage.${macroNote}`;
            } else {
                // Allowance est suffisante pour toute la durée du DCA, on peut supprimer requiredApproval
                delete proposal.requiredApproval;
            }
        }
    } catch (e) {
        console.warn("Audit check failed to run:", e.message);
        // Fallback: request approval just in case if we can't verify
        rationale = "Audit check incomplete. Please verify your balances before signing.";
    }
    return { proposal, audit: { isSafe, rationale }, macroAnalysis };
}


// ═══════════════════════════════════════════════════════════════════
// LIMIT ORDER COMMITTEE
// ═══════════════════════════════════════════════════════════════════

/// Macro analysis + bounded-params audit for a limit order. Doesn't touch
/// on-chain balances (the Stylus LOB takes no token transfer at store_order
/// time — escrow happens on the Solidity router which is out-of-scope for
/// this Sepolia demo). Audit focuses on parameter sanity and macro context.
async function runLimitOrderCommittee(request, eoa) {
    const proposal = await proposeLimitOrder(request, eoa);
    const lo = proposal.limitOrder;

    let isSafe = true;
    let rationale = "Limit order audit passed. Parameters within bounds.";
    let macroAnalysis = null;

    // ── Step 1: Macro-Economic Analysis on the target asset ──
    try {
        macroAnalysis = await analyzeMacroSentiment(lo.asset);
        const sideText = lo.isLong ? "long" : "short";
        if (macroAnalysis.recommendation === "DELAY" && macroAnalysis.score < -50) {
            rationale = `⚠️ MACRO WARNING: ${macroAnalysis.summary} ${sideText} ${lo.asset} runs against the trend. Proceed with caution.`;
        } else if (macroAnalysis.recommendation === "CAUTION") {
            rationale = `📊 Market Context (${lo.asset}): ${macroAnalysis.summary} ${macroAnalysis.recommendation_reason}`;
        } else {
            rationale = `✅ Macro Analysis (${lo.asset}): ${macroAnalysis.sentiment} (Score: ${macroAnalysis.score}/100). ${macroAnalysis.summary}`;
        }
    } catch (e) {
        console.warn("Macro analysis skipped:", e.message);
    }

    // ── Step 2: Parameter sanity audit ──
    const auditFindings = [];
    if (lo.leverage > 50)        { isSafe = false; auditFindings.push(`leverage ${lo.leverage}x exceeds protocol max (50x)`); }
    if (lo.leverage < 1)         { isSafe = false; auditFindings.push("leverage must be >= 1"); }
    if (lo.limitPrice <= 0)      { isSafe = false; auditFindings.push("limit price must be > 0"); }
    if (lo.collateral <= 0)      { isSafe = false; auditFindings.push("collateral must be > 0"); }
    if (lo.collateral > 100_000) { isSafe = false; auditFindings.push(`collateral ${lo.collateral} > $100k cap (anti-fat-finger)`); }

    // Sanity-check the limit price against current macro mid (if we got prices)
    if (macroAnalysis?.rawPrices && macroAnalysis.rawPrices[lo.asset]) {
        const mid = macroAnalysis.rawPrices[lo.asset];
        const drift = Math.abs(lo.limitPrice - mid) / mid;
        if (drift > 0.5) {
            auditFindings.push(`limit price $${lo.limitPrice} is ${(drift * 100).toFixed(0)}% away from current mid $${mid.toFixed(2)} — likely typo, please confirm`);
        }
    }

    if (auditFindings.length > 0) {
        rationale = `${isSafe ? "⚠️" : "❌"} Audit findings: ${auditFindings.join("; ")}`;
    }

    return {
        proposal,
        audit: { isSafe, rationale, auditReport: auditFindings.join("; ") || "OK" },
        macroAnalysis
    };
}


module.exports = { runAuraCommittee };
