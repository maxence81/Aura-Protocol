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
    "function closePosition(uint256 positionId) external"
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
        
        return { text, availableAssets };
    } catch (error) {
        console.error("[Arena] Erreur lors de la recuperation des donnees Pyth :", error.message);
        return { 
            text: "CURRENT MARKET STATE:\n- BTC/USD: $65000\n- ETH/USD: $3500\n- Sentiment: NEUTRAL",
            availableAssets: ["BTC", "ETH"]
        };
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
    
    const systemPrompt = `
${agentConfig.prompt}

${marketContextData.text}

Based on this, decide if you want to OPEN a trade, CLOSE existing, or HOLD.
Available assets: ${marketContextData.availableAssets.map(a => `"${a}"`).join(', ')}.
If you OPEN, specify leverage (max 20) and collateral (max 100).

You MUST respond ONLY with a valid JSON in this exact format:
{"action": "OPEN", "asset": "BTC", "isLong": true, "leverage": 10, "collateral": 50, "reasoning": "RSI is low, going long."}
OR
{"action": "HOLD", "reasoning": "Market too choppy."}

Do NOT wrap the JSON in Markdown code blocks. Just output raw JSON.
`;

    try {
        const response = await llm.invoke([{ role: "user", content: systemPrompt }]);
        let answer = response.content.trim();
        
        if (answer.startsWith("```json")) {
            answer = answer.replace(/```json/g, "").replace(/```/g, "").trim();
        }
        
        const decision = JSON.parse(answer);
        console.log(`[Arena] [${agentConfig.name}] Decision: ${decision.action}`);
        console.log(`[Arena] Raison: ${decision.reasoning}`);

        if (decision.action === "OPEN") {
            console.log(`[Arena] Execution: Lancement d'un ${decision.isLong ? 'LONG' : 'SHORT'} sur ${decision.asset} (Levier: x${decision.leverage})`);
            
            // Integration blockchain (Demonstration on-chain)
            const wallet = new ethers.Wallet(walletInfo.privateKey, provider);
            const perps = new ethers.Contract(PERPS_ADDRESS, PERPS_ABI, wallet);
            
            try {
                // Collateral est fourni par l'IA (max 100), converti en Wei (18 décimales)
                const safeCollateral = Math.min(Number(decision.collateral) || 50, 10000); 
                const collateralWei = ethers.parseUnits(safeCollateral.toString(), 18);
                const safeLeverage = Math.min(Number(decision.leverage) || 2, 20);

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
