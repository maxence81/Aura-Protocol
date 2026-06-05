require('dotenv').config({ override: true });
const { ethers } = require("ethers");
const { ChatOpenAI } = require("@langchain/openai");
const fs = require("fs");
const path = require("path");

// ==========================================
// CONFIGURATION DES AGENTS
// ==========================================
const ARENA_CONFIG = [
    {
        name: "DeepSeek-Degen",
        modelId: "deepseek-4-flash", 
        description: "Aggressive trader, looks for high volatility, uses high leverage (up to 20x). Ignores small risks.",
        prompt: "You are a highly aggressive crypto trader. You love volatility. Use up to 20x leverage. Your goal is to maximize short-term PnL.",
        interval: 30000, 
    },
    {
        name: "DeepSeek-Conservateur",
        modelId: "deepseek-3.2", 
        description: "Risk-averse institutional trader. Capital preservation is #1 goal. Tight stop-losses, low leverage.",
        prompt: "You are a risk-averse institutional trader. Capital preservation is your #1 goal. Never use more than 3x leverage. Always set tight stop-losses.",
        interval: 60000, 
    },
    {
        name: "Llama-Macro",
        modelId: "llama3.3-70b-instruct", 
        description: "Macro analyst. Trades based on market sentiment, funding rates, and long-term trends.",
        prompt: "You are a macro-analyst whale trader. You analyze broad market sentiment and funding rates. You take low leverage positional trades.",
        interval: 120000, 
    }
];

// ==========================================
// INITIALISATION BLOCKCHAIN
// ==========================================
const RPC_URL = process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);
const PERPS_ADDRESS = process.env.AURA_PERPS_ADDRESS || "0x8AECF449B27BB41E34C04D8C99F4348FF38bB9a2";
const AUSD_ADDRESS = process.env.AUSD_ADDRESS || "0x359961489f069F16E5dbA46d9b174bBF7b25147B";

const PERPS_ABI = [
    "function openPosition(string asset, bool isLong, uint256 collateralAmount, uint256 leverage) returns (uint256)",
    "function closePosition(uint256 positionId) external",
    "function nextPositionId() view returns (uint256)",
    "function positions(uint256) view returns (address owner, string asset, bool isLong, uint256 collateralAmount, uint256 leverage, uint256 entryPrice, uint256 positionSize, bool isOpen, uint256 openedAt, uint256 realizedPnl, bool isProfitRealized, uint256 exitPrice, uint256 takeProfitPrice, uint256 stopLossPrice)"
];

const AUSD_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

let agentsData = [];

function initWallets() {
    console.log("[Arena] Initialisation : Chargement des Wallets depuis l'environnement...");

    const keys = [
        { name: "Llama-Degen", envVar: "DEGEN_PK" },
        { name: "Claude-Conservateur", envVar: "CONSERVATIVE_PK" },
        { name: "GPT-Macro", envVar: "MACRO_PK" }
    ];

    let missing = false;

    keys.forEach((k) => {
        const pk = process.env[k.envVar];
        if (!pk) {
            missing = true;
        } else {
            const wallet = new ethers.Wallet(pk);
            agentsData.push({
                name: k.name,
                address: wallet.address,
                privateKey: pk
            });
        }
    });

    if (missing) {
        console.error("[Arena] Erreur : Il manque des cles privees dans votre environnement (.env ou Railway).");
        console.error("[Arena] Veuillez generer 3 portefeuilles et ajouter ces variables :");
        console.error(`DEGEN_PK=${ethers.Wallet.createRandom().privateKey}`);
        console.error(`CONSERVATIVE_PK=${ethers.Wallet.createRandom().privateKey}`);
        console.error(`MACRO_PK=${ethers.Wallet.createRandom().privateKey}`);
        process.exit(1);
    }

    agentsData.forEach(agent => {
        console.log(`[Arena] [${agent.name}] Wallet pret: ${agent.address}`);
    });
}

// ==========================================
// MOTEUR DE L'ARENE
// ==========================================
const market = require("./market");

// Cache for CMC Fear & Greed to avoid rate limits
let cmcCache = { value: null, classification: null, lastFetch: 0 };

async function getRealSentiment() {
    try {
        const now = Date.now();
        if (now - cmcCache.lastFetch < 300000 && cmcCache.value !== null) {
            return cmcCache; // Cache 5 min
        }

        const apiKey = process.env.COINMARKETCAP;
        if (!apiKey) return { value: 50, classification: "Neutral (No API Key)" };

        const response = await fetch("https://pro-api.coinmarketcap.com/v3/fear-and-greed/latest", {
            headers: {
                "X-CMC_PRO_API_KEY": apiKey,
                "Accept": "application/json"
            }
        });

        if (response.ok) {
            const data = await response.json();
            cmcCache = {
                value: data.data.value,
                classification: data.data.value_classification,
                lastFetch: now
            };
            return cmcCache;
        }
        return { value: 50, classification: "Neutral (API Error)" };
    } catch (e) {
        return { value: 50, classification: "Neutral (Network Error)" };
    }
}

async function getArenaContext() {
    try {
        const [ctx, sentiment] = await Promise.all([
            market.getMarketContext(),
            getRealSentiment()
        ]);
        
        let text = `CURRENT MARKET STATE:\n`;
        const availableAssets = [];
        
        if (ctx.prices) {
            for (const [symbol, price] of Object.entries(ctx.prices)) {
                if (price) {
                    text += `- ${symbol}/USD: $${price.toFixed(2)} (Pyth Network Oracle)\n`;
                    availableAssets.push(symbol);
                }
            }
        }
        
        if (availableAssets.length === 0) {
            text += `- BTC/USD: $65000.00\n- ETH/USD: $3500.00\n`;
            availableAssets.push("BTC", "ETH");
        }
        
        text += `- Global Market Sentiment: ${sentiment.classification} (Score: ${sentiment.value}/100 via CoinMarketCap)\n`;
        text += `- Latest Macro News:\n`;
        
        if (ctx.news && ctx.news.length > 0) {
            ctx.news.slice(0, 3).forEach(n => {
                text += `  * ${n.title}\n`;
            });
        } else {
            text += `  * No significant news currently.\n`;
        }
        
        return { text, availableAssets, fearScore: sentiment.value };
    } catch (error) {
        console.error("[Arena] Erreur lors de la recuperation des donnees Pyth :", error.message);
        return { 
            text: "CURRENT MARKET STATE:\n- BTC/USD: $65000\n- ETH/USD: $3500\n- Sentiment: NEUTRAL",
            availableAssets: ["BTC", "ETH"],
            fearScore: 50
        };
    }
}

async function getAgentPortfolioContext(wallet) {
    const perps = new ethers.Contract(PERPS_ADDRESS, PERPS_ABI, wallet);
    try {
        const nextId = await perps.nextPositionId();
        let openPos = [];
        let closedCount = 0;
        let wins = 0;
        let losses = 0;
        let totalPnlWei = 0n;

        for (let i = 0; i < nextId; i++) {
            const pos = await perps.positions(i);
            if (pos.owner.toLowerCase() === wallet.address.toLowerCase()) {
                if (pos.isOpen) {
                    openPos.push(`- Position #${i}: ${pos.isLong ? 'LONG' : 'SHORT'} on ${pos.asset} (Leverage: x${pos.leverage}, Collateral: $${ethers.formatUnits(pos.collateralAmount, 18)})`);
                } else {
                    closedCount++;
                    if (pos.isProfitRealized) {
                        wins++;
                        totalPnlWei += pos.realizedPnl;
                    } else {
                        losses++;
                        totalPnlWei -= pos.realizedPnl;
                    }
                }
            }
        }

        let context = "";
        
        // 1. Open Positions
        if (openPos.length > 0) {
            context += `[CURRENT OPEN POSITIONS]\n${openPos.join('\n')}\n(Note: if you choose CLOSE, all your open positions will be closed to secure PnL or stop losses.)\n\n`;
        } else {
            context += `[CURRENT OPEN POSITIONS]\nYou currently have NO open positions.\n\n`;
        }

        // 2. Historical Reflection (Self-Correction)
        if (closedCount > 0) {
            const winRate = ((wins / closedCount) * 100).toFixed(2);
            const netPnl = ethers.formatUnits(totalPnlWei > 0n ? totalPnlWei : -totalPnlWei, 18);
            const sign = totalPnlWei >= 0n ? "+" : "-";
            context += `[SELF-REFLECTION: PAST PERFORMANCE]\nTotal Past Trades: ${closedCount}\nWins: ${wins} | Losses: ${losses} (Win Rate: ${winRate}%)\nNet Realized PnL: ${sign}$${netPnl}\n`;
            
            if (totalPnlWei < 0n) {
                context += `CRITICAL INSTRUCTION: You are currently losing money. Your past strategies failed. Reflect on your losses, avoid over-leveraging, and DO NOT force trades. Demand a much higher edge before opening a new position.\n`;
            } else {
                context += `INSTRUCTION: You are profitable. Keep applying your winning patterns but manage your risk.\n`;
            }
        } else {
            context += `[SELF-REFLECTION]\nNo past trades found. This is your first trade. Be cautious.\n`;
        }

        return context;
    } catch (e) {
        console.error("Error fetching portfolio context", e);
        return "[PORTFOLIO INFO UNAVAILABLE]";
    }
}

async function runAgent(agentConfig, walletInfo) {
    console.log(`\n[Arena] [${agentConfig.name}] Reçoit le contexte du marche...`);
    
    const llm = new ChatOpenAI({
        apiKey: process.env.DO_API_KEY,
        modelName: agentConfig.modelId,
        temperature: 0.2, 
        configuration: {
            baseURL: "https://inference.do-ai.run/v1",
        },
    });

    const marketContextData = await getArenaContext();
    
    const wallet = new ethers.Wallet(walletInfo.privateKey, provider);
    const portfolioContext = await getAgentPortfolioContext(wallet);

    const { execSync } = require('child_process');
    let ragContext = "";
    try {
        const fear = marketContextData.fearScore || 50;
        console.log(`[Arena] [${agentConfig.name}] Recherche de similarité historique pour tous les actifs (GCP RAG)...`);
        
        for (const asset of marketContextData.availableAssets) {
            try {
                const res = execSync(`python data_ingestion/similarity_search.py ${asset} ${fear} -0.02 0.04 52.0`, { cwd: process.cwd() });
                ragContext += `--- ${asset} LONG-TERM MEMORY ---\n` + res.toString().trim() + "\n\n";
            } catch (innerE) {
                // Ignore missing asset in DB
            }
        }
    } catch (e) {
        console.error("[Arena] RAG Error:", e.message);
    }

    const systemPrompt = `
${agentConfig.prompt}

${marketContextData.text}

${ragContext}

${portfolioContext}

Based on the market and your past performance, decide if you want to OPEN a new trade, CLOSE existing, or HOLD.
Available assets: ${marketContextData.availableAssets.map(a => `"${a}"`).join(', ')}.
If you OPEN, specify leverage (max 20) and collateral (between 10000 and 250000).

You MUST respond ONLY with a valid JSON in this exact format:
{"action": "OPEN", "asset": "BTC", "isLong": true, "leverage": 10, "collateral": 50000, "confidence_score": 85, "reasoning": "RSI is low, and my win-rate suggests I should take this."}
OR
{"action": "CLOSE", "confidence_score": 90, "reasoning": "Market is turning, closing all positions to secure capital."}
OR
{"action": "HOLD", "confidence_score": 100, "reasoning": "Market too choppy, confidence in edge is too low (< 75)."}

RULES:
1. Do NOT wrap the JSON in Markdown code blocks. Just output raw JSON.
2. Provide a "confidence_score" between 0 and 100 representing how certain you are of your edge.
3. If your confidence is below 75, you MUST choose HOLD. Do not trade just to trade.
`;

    try {
        const response = await llm.invoke([{ role: "user", content: systemPrompt }]);
        let answer = response.content.trim();
        
        if (answer.startsWith("```json")) {
            answer = answer.replace(/```json/g, "").replace(/```/g, "").trim();
        }
        
        const decision = JSON.parse(answer);
        console.log(`[Arena] [${agentConfig.name}] Decision: ${decision.action} (Confidence: ${decision.confidence_score}%)`);
        console.log(`[Arena] Raison: ${decision.reasoning}`);

        // ANTI-SPAM: Enforce high confidence threshold
        if (decision.action === "OPEN" && decision.confidence_score < 75) {
            console.log(`[Arena] 🛡️ ANTI-SPAM TRIGGERED: Confidence (${decision.confidence_score}%) too low. Forcing HOLD to protect capital.`);
            return;
        }

        if (decision.action === "OPEN") {
            const safeCollateral = Math.min(Math.max(Number(decision.collateral) || 50000, 10000), 250000); 
            const safeLeverage = Math.min(Number(decision.leverage) || 2, 20);
            const totalPositionSize = safeCollateral * safeLeverage;

            console.log(`[Arena] Execution: Lancement d'un ${decision.isLong ? 'LONG' : 'SHORT'} sur ${decision.asset}`);
            console.log(`[Arena] Paramètres: Marge = $${safeCollateral.toLocaleString()} | Levier = x${safeLeverage} | Taille Totale = $${totalPositionSize.toLocaleString()}`);
            
            // Integration blockchain (Demonstration on-chain)
            const wallet = new ethers.Wallet(walletInfo.privateKey, provider);
            const perps = new ethers.Contract(PERPS_ADDRESS, PERPS_ABI, wallet);
            
            try {
                // Collateral converti en Wei (18 décimales)
                const collateralWei = ethers.parseUnits(safeCollateral.toString(), 18);

                // --- GESTION DE L'APPROBATION aUSD ---
                const ausd = new ethers.Contract(AUSD_ADDRESS, AUSD_ABI, wallet);
                const allowance = await ausd.allowance(wallet.address, PERPS_ADDRESS);
                if (allowance < collateralWei) {
                    console.log(`[Arena] Approve aUSD pour le contrat AuraPerps...`);
                    const approveTx = await ausd.approve(PERPS_ADDRESS, ethers.MaxUint256);
                    await approveTx.wait();
                    console.log(`[Arena] Approve aUSD reussi.`);
                }
                // -------------------------------------

                const tx = await perps.openPosition(decision.asset, decision.isLong, collateralWei, safeLeverage);
                console.log(`[Arena] Tx envoyee: ${tx.hash}`);
                console.log(`[Arena] Succes: Ordre reel place sur la Robinhood Chain !`);
            } catch (txError) {
                console.error(`[Arena] Echec de la transaction on-chain:`, txError.reason || txError.message);
            }
        } else if (decision.action === "CLOSE") {
            console.log(`[Arena] Execution: Tentative de cloture des positions pour l'agent`);
            const wallet = new ethers.Wallet(walletInfo.privateKey, provider);
            const perps = new ethers.Contract(PERPS_ADDRESS, PERPS_ABI, wallet);
            
            try {
                // In a real scenario, the agent would close a specific position ID. 
                // For the hackathon, we simply fetch all open positions of this agent and close them.
                const nextId = await perps.nextPositionId();
                let closedCount = 0;
                for (let i = 0; i < nextId; i++) {
                    const pos = await perps.positions(i);
                    if (pos.isOpen && pos.owner.toLowerCase() === wallet.address.toLowerCase()) {
                        console.log(`[Arena] Closing position #${i} on ${pos.asset}...`);
                        const tx = await perps.closePosition(i);
                        await tx.wait();
                        console.log(`[Arena] Position #${i} closed. Tx: ${tx.hash}`);
                        closedCount++;
                    }
                }
                if (closedCount === 0) {
                    console.log(`[Arena] Aucune position ouverte à cloturer.`);
                }
            } catch (txError) {
                console.error(`[Arena] Echec de la cloture:`, txError.reason || txError.message);
            }
        }

    } catch (error) {
        console.error(`[Arena] [${agentConfig.name}] Erreur d'analyse ou de format JSON:`, error.message);
    }
}

async function startArena() {
    console.log("==================================================");
    console.log("  DEMARRAGE DE L'AI TRADING ARENA (AURA PROTOCOL) ");
    console.log("==================================================");
    initWallets();
    console.log("--------------------------------------------------");

    ARENA_CONFIG.forEach((config, index) => {
        const walletInfo = agentsData[index];
        
        setTimeout(() => runAgent(config, walletInfo), index * 2000); 
        
        setInterval(() => {
            runAgent(config, walletInfo);
        }, config.interval);
    });
}

if (require.main === module) {
    startArena();
}

module.exports = { startArena, ARENA_CONFIG };
