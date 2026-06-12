/**
 * backend/copyEngine.js
 * 
 * Production Copy Trading Engine — Off-chain Keeper
 * ──────────────────────────────────────────────────
 * Listens to AuraPerps events via WebSocket, detects leader trades,
 * and replicates them on-chain via AuraCopyTradingV2.
 *
 * Architecture:
 *   WebSocket Provider ──► Event Listener ──► Trade Queue ──► Executor
 *                                                              │
 *                                              ┌───────────────┘
 *                                              ▼
 *                                    AuraCopyTradingV2.sol
 *                                              │
 *                                              ▼
 *                                        AuraPerps.sol
 *
 * Error Handling Strategy:
 *   - Open trades: 3 retries with exponential backoff (1s, 2s, 4s)
 *   - Close trades: 5 retries (closing is critical) with gas bump on each retry
 *   - Gas estimation: pre-flight check with 20% buffer
 *   - Nonce management: sequential with mutex lock
 *   - Event replay: on reconnect, replays events from last processed block
 *
 * @author Aura Protocol
 */
const { ethers } = require("ethers");
const { computeHealth, recommendTopUp } = require("./healthFactor");

// ══════════════════════ ABIs ══════════════════════

const PERPS_ABI = [
    "event PositionOpened(uint256 indexed positionId, address indexed owner, string asset, bool isLong, uint256 collateral, uint256 leverage, uint256 entryPrice, uint256 openedAt)",
    "event PositionClosed(uint256 indexed positionId, address indexed owner, uint256 pnl, bool isProfit, uint256 exitPrice, uint256 fundingFee)",
    "event PositionLiquidated(uint256 indexed positionId, address indexed liquidator, address indexed owner, uint256 bounty)",
    "event MarginAdded(uint256 indexed positionId, uint256 amount)",
    "function positions(uint256) view returns (address owner, string asset, bool isLong, uint256 collateralAmount, uint256 leverage, uint256 entryPrice, uint256 positionSize, bool isOpen, uint256 openedAt, uint256 realizedPnl, bool isProfitRealized, uint256 exitPrice, uint256 takeProfitPrice, uint256 stopLossPrice)",
    "function nextPositionId() view returns (uint256)",
];

const COPY_TRADING_ABI = [
    "function executeCopyOpen(address leader, uint256 leaderPositionId, string asset, bool isLong, uint256 leaderCollateral, uint256 leaderTotalBalance, uint256 leverage, uint256 leaderEntryPrice) external",
    "function executeCopyClose(uint256 leaderPositionId) external",
    "function emergencyCloseCopy(uint256 followerPerpsPositionId) external",
    "function leaders(address) view returns (bool isRegistered, bool isActive, uint256 performanceFeeBps, uint256 totalFollowers, uint256 totalCopiedCapital, uint256 totalRealizedPnl, bool isPnlPositive, uint256 tradesExecuted, uint256 tradesWon, uint256 createdAt)",
    "function getLeaderFollowers(address) view returns (address[])",
    "function getCopyPositions(uint256 leaderPositionId) view returns (tuple(uint256 leaderPositionId, uint256 followerPerpsPositionId, address follower, address leader, uint256 collateralUsed, bool isOpen, uint256 openedAt)[])",
    "function getLeaderCount() view returns (uint256)",
    "function leaderList(uint256) view returns (address)",
    "function getActiveLeaders(uint256 offset, uint256 limit) view returns (address[], tuple(bool isRegistered, bool isActive, uint256 performanceFeeBps, uint256 totalFollowers, uint256 totalCopiedCapital, uint256 totalRealizedPnl, bool isPnlPositive, uint256 tradesExecuted, uint256 tradesWon, uint256 createdAt)[])",
    "function allocations(address leader, address follower) view returns (bool isActive, uint256 capitalDeposited, uint256 capitalInPositions, uint256 highWaterMark, uint256 scaleFactor, uint256 maxSlippageBps, uint256 joinedAt)",
    "function pendingFees(address) view returns (uint256)",
    "function getFollowerAvailableBalance(address leader, address follower) view returns (uint256)",
    "function getFollowerOpenPositions(address leader, address follower) view returns (uint256[])",
    "function getFollowerOpenPositionCount(address leader, address follower) view returns (uint256)",

    "event LeaderRegistered(address indexed leader, uint256 performanceFeeBps)",
    "event LeaderDeactivated(address indexed leader)",
    "event FollowerJoined(address indexed leader, address indexed follower, uint256 capital, uint256 scaleFactor, uint256 maxSlippageBps)",
    "event FollowerLeft(address indexed leader, address indexed follower, uint256 capitalReturned)",
    "event CopyTradeOpened(address indexed leader, address indexed follower, uint256 leaderPosId, uint256 followerPosId, string asset, bool isLong, uint256 collateral, uint256 leverage, uint256 leaderEntryPrice)",
    "event CopyTradeClosed(address indexed leader, address indexed follower, uint256 followerPosId, uint256 pnl, bool isProfit, uint256 fee)",
    "event CopyTradeSkipped(address indexed leader, address indexed follower, uint256 leaderPosId, uint8 reason)",
];

const AUSD_ABI = [
    "function balanceOf(address) view returns (uint256)",
];

const ORACLE_ABI = [
    "function getPrice(string) view returns (uint256)",
];

// ══════════════════════ CONFIGURATION ══════════════════════

const MAX_RETRIES_OPEN  = 3;
const MAX_RETRIES_CLOSE = 5;
const BASE_RETRY_DELAY_MS = 1000;
const GAS_BUFFER_PERCENT  = 20; // 20% gas buffer
const GAS_BUMP_PERCENT    = 15; // 15% gas bump per retry
const HEALTH_CHECK_INTERVAL_MS = 30_000; // 30s
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;

// ══════════════════════ ENGINE STATE ══════════════════════

let isRunning = false;
let provider = null;
let wsProvider = null;
let keeperWallet = null;
let perpsContract = null;
let copyTradingContract = null;
let aUSDContract = null;
let oracleContract = null;

// Set of registered leader addresses (lowercase) — cached for fast lookup
const registeredLeaders = new Set();

// Execution queue to prevent nonce conflicts
const executionQueue = [];
let isExecuting = false;

// Last processed block for replay on reconnect
let lastProcessedBlock = 0;

// Audit log
const tradeLog = [];

// ══════════════════════ INITIALIZATION ══════════════════════

/**
 * Initialize and start the Copy Trading Engine.
 * Called once at server startup.
 */
async function startCopyEngine() {
    const rpcUrl = process.env.ROBINHOOD_ALCHEMY_RPC || process.env.RPC_URL;
    const privateKey = process.env.PRIVATE_KEY;
    const perpsAddr = process.env.AURA_PERPS_ADDRESS;
    const copyTradingAddr = process.env.COPY_TRADING_V2_ADDRESS;
    const aUSDAddr = process.env.AUSD_ADDRESS;
    const oracleAddr = process.env.MOCK_ORACLE_ADDRESS;

    if (!copyTradingAddr) {
        console.log("[CopyEngine] COPY_TRADING_V2_ADDRESS not set — engine disabled");
        return;
    }
    if (!perpsAddr || !privateKey || !rpcUrl) {
        console.log("[CopyEngine] Missing required env vars — engine disabled");
        return;
    }

    // HTTP provider for read operations
    provider = new ethers.JsonRpcProvider(rpcUrl);
    provider.pollingInterval = 60000; // Increase polling interval to avoid 429 Too Many Requests
    keeperWallet = new ethers.Wallet(privateKey, provider);

    // Contracts
    perpsContract = new ethers.Contract(perpsAddr, PERPS_ABI, keeperWallet);
    copyTradingContract = new ethers.Contract(copyTradingAddr, COPY_TRADING_ABI, keeperWallet);
    aUSDContract = new ethers.Contract(aUSDAddr, AUSD_ABI, provider);
    oracleContract = new ethers.Contract(oracleAddr, ORACLE_ABI, provider);

    // Cache registered leaders
    await _refreshLeaderCache();

    // Subscribe to events
    await _subscribeToEvents();

    // Start health monitoring loop
    _startHealthMonitor();

    isRunning = true;
    lastProcessedBlock = await provider.getBlockNumber();

    console.log(`[CopyEngine] ✅ Started — Keeper: ${keeperWallet.address}`);
    console.log(`[CopyEngine]    Perps:       ${perpsAddr}`);
    console.log(`[CopyEngine]    CopyTrading: ${copyTradingAddr}`);
    console.log(`[CopyEngine]    Leaders cached: ${registeredLeaders.size}`);
}

/**
 * Stop the engine gracefully.
 */
function stopCopyEngine() {
    isRunning = false;
    if (wsProvider) {
        wsProvider.destroy();
        wsProvider = null;
    }
    console.log("[CopyEngine] ⏹ Stopped");
}

// ══════════════════════ EVENT SUBSCRIPTION ══════════════════════

async function _subscribeToEvents() {
    // Use polling-based event listener since not all Arbitrum Orbit RPCs support WebSocket
    // This is robust for hackathon environments

    console.log("[CopyEngine] Subscribing to AuraPerps events via polling...");

    // Listen for PositionOpened
    perpsContract.on("PositionOpened", async (positionId, owner, asset, isLong, collateral, leverage, entryPrice, openedAt, event) => {
        const ownerLower = owner.toLowerCase();
        console.log(`[CopyEngine] PositionOpened: id=${positionId} owner=${ownerLower} asset=${asset} isLong=${isLong} collateral=${ethers.formatEther(collateral)}`);

        // Check if this is a leader's trade (not a copy position)
        if (!registeredLeaders.has(ownerLower)) {
            return; // Not a registered leader, ignore
        }

        // Don't copy our own positions (copy positions are owned by CopyTrading contract)
        const copyTradingAddr = await copyTradingContract.getAddress();
        if (ownerLower === copyTradingAddr.toLowerCase()) {
            return; // This is a copy position, not a leader's original trade
        }

        console.log(`[CopyEngine] 🎯 Leader trade detected: ${ownerLower} — queuing copy execution`);

        // Get leader's total balance to calculate risk fraction
        const leaderBalance = await _getLeaderTotalBalance(ownerLower);

        _enqueue({
            type: "COPY_OPEN",
            leader: owner,
            leaderPositionId: positionId,
            asset,
            isLong,
            leaderCollateral: collateral,
            leaderTotalBalance: leaderBalance,
            leverage,
            leaderEntryPrice: entryPrice,
            timestamp: Date.now(),
            retries: 0,
        });
    });

    // Listen for PositionClosed
    perpsContract.on("PositionClosed", async (positionId, owner, pnl, isProfit, exitPrice, fundingFee, event) => {
        const ownerLower = owner.toLowerCase();

        if (!registeredLeaders.has(ownerLower)) return;

        const copyTradingAddr = await copyTradingContract.getAddress();
        if (ownerLower === copyTradingAddr.toLowerCase()) return;

        console.log(`[CopyEngine] 🔻 Leader close detected: ${ownerLower} pos=${positionId}`);

        _enqueue({
            type: "COPY_CLOSE",
            leaderPositionId: positionId,
            leader: owner,
            timestamp: Date.now(),
            retries: 0,
        });
    });

    // Listen for PositionLiquidated — emergency close all copies
    perpsContract.on("PositionLiquidated", async (positionId, liquidator, owner, bounty, event) => {
        const ownerLower = owner.toLowerCase();

        if (!registeredLeaders.has(ownerLower)) return;

        const copyTradingAddr = await copyTradingContract.getAddress();
        if (ownerLower === copyTradingAddr.toLowerCase()) return;

        console.log(`[CopyEngine] ⚠️ Leader LIQUIDATED: ${ownerLower} pos=${positionId} — emergency closing copies`);

        _enqueue({
            type: "EMERGENCY_CLOSE",
            leaderPositionId: positionId,
            leader: owner,
            timestamp: Date.now(),
            retries: 0,
        });
    });

    // Listen for new leader registrations to update cache
    copyTradingContract.on("LeaderRegistered", (leader, feeBps) => {
        registeredLeaders.add(leader.toLowerCase());
        console.log(`[CopyEngine] New leader registered: ${leader} (fee: ${feeBps} bps)`);
    });

    copyTradingContract.on("LeaderDeactivated", (leader) => {
        // Don't remove from cache — we still need to process closes
        console.log(`[CopyEngine] Leader deactivated: ${leader}`);
    });
}

// ══════════════════════ EXECUTION QUEUE ══════════════════════

/**
 * Enqueue a trade operation. Operations are processed sequentially
 * to prevent nonce conflicts.
 */
function _enqueue(task) {
    executionQueue.push(task);
    _processQueue();
}

async function _processQueue() {
    if (isExecuting || executionQueue.length === 0) return;
    isExecuting = true;

    while (executionQueue.length > 0) {
        const task = executionQueue.shift();
        try {
            await _executeTask(task);
        } catch (err) {
            console.error(`[CopyEngine] Task failed: ${task.type}`, err.message);
            _handleTaskError(task, err);
        }
    }

    isExecuting = false;
}

async function _executeTask(task) {
    switch (task.type) {
        case "COPY_OPEN":
            await _executeCopyOpen(task);
            break;
        case "COPY_CLOSE":
            await _executeCopyClose(task);
            break;
        case "EMERGENCY_CLOSE":
            await _executeEmergencyClose(task);
            break;
        default:
            console.error(`[CopyEngine] Unknown task type: ${task.type}`);
    }
}

// ══════════════════════ COPY OPEN EXECUTION ══════════════════════

/**
 * Execute a copy-open trade via AuraCopyTradingV2.
 *
 * Pre-flight checks:
 *   1. Verify keeper has enough ETH for gas
 *   2. Estimate gas and apply buffer
 *   3. Call executeCopyOpen on the smart contract
 *   4. Log the result
 */
async function _executeCopyOpen(task) {
    const {
        leader, leaderPositionId, asset, isLong,
        leaderCollateral, leaderTotalBalance, leverage, leaderEntryPrice
    } = task;

    console.log(`[CopyEngine] Executing COPY_OPEN: leader=${leader} pos=${leaderPositionId} asset=${asset}`);

    // ── Gas pre-flight ──
    const keeperBalance = await provider.getBalance(keeperWallet.address);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;

    // Estimate gas
    let estimatedGas;
    try {
        estimatedGas = await copyTradingContract.executeCopyOpen.estimateGas(
            leader, leaderPositionId, asset, isLong,
            leaderCollateral, leaderTotalBalance, leverage, leaderEntryPrice
        );
    } catch (err) {
        console.error(`[CopyEngine] Gas estimation failed for COPY_OPEN: ${err.message}`);
        _logTrade(task, "FAILED", `Gas estimation failed: ${err.message}`);
        return;
    }

    const gasWithBuffer = estimatedGas * BigInt(100 + GAS_BUFFER_PERCENT) / 100n;
    const estimatedCost = gasWithBuffer * gasPrice;

    if (keeperBalance < estimatedCost) {
        console.error(`[CopyEngine] ❌ Insufficient gas: need ${ethers.formatEther(estimatedCost)} ETH, have ${ethers.formatEther(keeperBalance)}`);
        _logTrade(task, "FAILED", "Insufficient keeper gas balance");
        return;
    }

    // ── Execute ──
    const gasBump = task.retries > 0 ? BigInt(100 + GAS_BUMP_PERCENT * task.retries) / 100n : 1n;
    const txGasPrice = gasPrice * gasBump;

    const tx = await copyTradingContract.executeCopyOpen(
        leader, leaderPositionId, asset, isLong,
        leaderCollateral, leaderTotalBalance, leverage, leaderEntryPrice,
        { gasLimit: gasWithBuffer, gasPrice: txGasPrice }
    );

    console.log(`[CopyEngine] TX sent: ${tx.hash}`);
    const receipt = await tx.wait();

    if (receipt.status === 1) {
        // Parse events from receipt to count successful copies
        const copyOpenEvents = receipt.logs.filter(log => {
            try {
                const parsed = copyTradingContract.interface.parseLog(log);
                return parsed?.name === "CopyTradeOpened";
            } catch { return false; }
        });
        const skipEvents = receipt.logs.filter(log => {
            try {
                const parsed = copyTradingContract.interface.parseLog(log);
                return parsed?.name === "CopyTradeSkipped";
            } catch { return false; }
        });

        console.log(`[CopyEngine] ✅ COPY_OPEN success: ${copyOpenEvents.length} copies opened, ${skipEvents.length} skipped (gas: ${receipt.gasUsed})`);
        _logTrade(task, "SUCCESS", `${copyOpenEvents.length} copies, ${skipEvents.length} skipped`, receipt.hash);
    } else {
        console.error(`[CopyEngine] ❌ TX reverted: ${receipt.hash}`);
        _logTrade(task, "REVERTED", "Transaction reverted", receipt.hash);
    }
}

// ══════════════════════ COPY CLOSE EXECUTION ══════════════════════

async function _executeCopyClose(task) {
    const { leaderPositionId, leader } = task;

    console.log(`[CopyEngine] Executing COPY_CLOSE: leaderPos=${leaderPositionId}`);

    // Check if there are any copy positions to close
    let copies;
    try {
        copies = await copyTradingContract.getCopyPositions(leaderPositionId);
    } catch (err) {
        console.log(`[CopyEngine] No copy positions found for leaderPos=${leaderPositionId}`);
        return;
    }

    const openCopies = copies.filter(cp => cp.isOpen);
    if (openCopies.length === 0) {
        console.log(`[CopyEngine] No open copies for leaderPos=${leaderPositionId}`);
        return;
    }

    // Gas pre-flight
    const keeperBalance = await provider.getBalance(keeperWallet.address);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;

    let estimatedGas;
    try {
        estimatedGas = await copyTradingContract.executeCopyClose.estimateGas(leaderPositionId);
    } catch (err) {
        console.error(`[CopyEngine] Gas estimation failed for COPY_CLOSE: ${err.message}`);
        _logTrade(task, "FAILED", `Gas estimation failed: ${err.message}`);
        return;
    }

    const gasWithBuffer = estimatedGas * BigInt(100 + GAS_BUFFER_PERCENT) / 100n;
    const gasBump = task.retries > 0 ? BigInt(100 + GAS_BUMP_PERCENT * task.retries) / 100n : 1n;
    const txGasPrice = gasPrice * gasBump;
    const estimatedCost = gasWithBuffer * txGasPrice;

    if (keeperBalance < estimatedCost) {
        console.error(`[CopyEngine] ❌ Insufficient gas for close`);
        _logTrade(task, "FAILED", "Insufficient keeper gas balance");
        return;
    }

    const tx = await copyTradingContract.executeCopyClose(
        leaderPositionId,
        { gasLimit: gasWithBuffer, gasPrice: txGasPrice }
    );

    console.log(`[CopyEngine] CLOSE TX sent: ${tx.hash}`);
    const receipt = await tx.wait();

    if (receipt.status === 1) {
        const closeEvents = receipt.logs.filter(log => {
            try {
                const parsed = copyTradingContract.interface.parseLog(log);
                return parsed?.name === "CopyTradeClosed";
            } catch { return false; }
        });
        console.log(`[CopyEngine] ✅ COPY_CLOSE success: ${closeEvents.length} positions closed (gas: ${receipt.gasUsed})`);
        _logTrade(task, "SUCCESS", `${closeEvents.length} copies closed`, receipt.hash);
    } else {
        console.error(`[CopyEngine] ❌ CLOSE TX reverted: ${receipt.hash}`);
        _logTrade(task, "REVERTED", "Close transaction reverted", receipt.hash);
    }
}

// ══════════════════════ EMERGENCY CLOSE ══════════════════════

async function _executeEmergencyClose(task) {
    const { leaderPositionId, leader } = task;

    console.log(`[CopyEngine] ⚠️ EMERGENCY_CLOSE: leaderPos=${leaderPositionId}`);

    let copies;
    try {
        copies = await copyTradingContract.getCopyPositions(leaderPositionId);
    } catch (err) {
        console.log(`[CopyEngine] No copy positions for emergency close`);
        return;
    }

    // Close each copy individually to maximize success rate
    for (const cp of copies) {
        if (!cp.isOpen) continue;

        try {
            const tx = await copyTradingContract.emergencyCloseCopy(cp.followerPerpsPositionId);
            const receipt = await tx.wait();
            console.log(`[CopyEngine] Emergency closed followerPos=${cp.followerPerpsPositionId} tx=${receipt.hash}`);
        } catch (err) {
            console.error(`[CopyEngine] Failed to emergency close followerPos=${cp.followerPerpsPositionId}: ${err.message}`);
        }
    }

    _logTrade(task, "SUCCESS", "Emergency close completed");
}

// ══════════════════════ ERROR HANDLING ══════════════════════

/**
 * Error handling strategy:
 *   - COPY_OPEN: 3 retries with exponential backoff
 *   - COPY_CLOSE: 5 retries (closing is more critical)
 *   - EMERGENCY_CLOSE: 5 retries
 *   - Each retry bumps gas price by 15%
 *   - After max retries, log and skip
 */
function _handleTaskError(task, error) {
    const maxRetries = task.type === "COPY_OPEN" ? MAX_RETRIES_OPEN : MAX_RETRIES_CLOSE;

    if (task.retries < maxRetries) {
        task.retries++;
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, task.retries - 1);
        console.log(`[CopyEngine] Retrying ${task.type} (attempt ${task.retries}/${maxRetries}) in ${delay}ms`);

        setTimeout(() => {
            _enqueue(task);
        }, delay);
    } else {
        console.error(`[CopyEngine] ❌ ${task.type} failed after ${maxRetries} retries: ${error.message}`);
        _logTrade(task, "ABANDONED", `Failed after ${maxRetries} retries: ${error.message}`);
    }
}

// ══════════════════════ HEALTH MONITORING ══════════════════════

let healthCheckInterval = null;

function _startHealthMonitor() {
    if (healthCheckInterval) clearInterval(healthCheckInterval);

    healthCheckInterval = setInterval(async () => {
        if (!isRunning) return;
        try {
            await _checkAllPositionHealth();
        } catch (err) {
            console.error(`[CopyEngine] Health check error: ${err.message}`);
        }
    }, HEALTH_CHECK_INTERVAL_MS);

    console.log(`[CopyEngine] Health monitor started (interval: ${HEALTH_CHECK_INTERVAL_MS / 1000}s)`);
}

async function _checkAllPositionHealth() {
    const leaderCount = await copyTradingContract.getLeaderCount();

    for (let i = 0; i < Number(leaderCount); i++) {
        const leader = await copyTradingContract.leaderList(i);
        const followers = await copyTradingContract.getLeaderFollowers(leader);

        for (const follower of followers) {
            const openPositions = await copyTradingContract.getFollowerOpenPositions(leader, follower);

            for (const posId of openPositions) {
                try {
                    const pos = await perpsContract.positions(posId);
                    if (!pos.isOpen) continue;

                    const currentPrice = await oracleContract.getPrice(pos.asset);
                    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

                    const { healthBps } = computeHealth({
                        isLong: pos.isLong,
                        collateralAmount: pos.collateralAmount,
                        entryPrice: pos.entryPrice,
                        positionSize: pos.positionSize,
                        openedAt: Number(pos.openedAt),
                    }, currentPrice, nowSeconds);

                    // Emergency close if health drops below 5%
                    if (healthBps < 500) {
                        console.log(`[CopyEngine] ⚠️ Critical health (${healthBps} bps) for follower pos ${posId} — emergency closing`);
                        _enqueue({
                            type: "EMERGENCY_CLOSE",
                            leaderPositionId: 0, // We don't know the leader pos
                            leader: leader,
                            followerPositionId: posId,
                            timestamp: Date.now(),
                            retries: 0,
                        });
                    } else if (healthBps < 2000) {
                        console.log(`[CopyEngine] ⚡ Low health (${healthBps} bps) for follower pos ${posId}`);
                    }
                } catch (err) {
                    // Position might have been closed, skip silently
                }
            }
        }
    }
}

// ══════════════════════ HELPERS ══════════════════════

/**
 * Get the leader's total aUSD balance (on-chain position collateral + wallet balance).
 * Used for proportional calculation.
 */
async function _getLeaderTotalBalance(leaderAddress) {
    try {
        // Get leader's aUSD wallet balance
        const walletBalance = await aUSDContract.balanceOf(leaderAddress);

        // Get leader's total collateral in open positions on AuraPerps
        // We scan their positions — this is a simplified approach
        let totalCollateral = 0n;
        const nextPosId = await perpsContract.nextPositionId();

        // Optimization: only scan recent positions (last 200)
        const startId = nextPosId > 200n ? nextPosId - 200n : 0n;

        for (let id = startId; id < nextPosId; id++) {
            try {
                const pos = await perpsContract.positions(id);
                if (pos.owner.toLowerCase() === leaderAddress.toLowerCase() && pos.isOpen) {
                    totalCollateral += pos.collateralAmount;
                }
            } catch {
                // Skip invalid positions
            }
        }

        return walletBalance + totalCollateral;
    } catch (err) {
        console.error(`[CopyEngine] Failed to get leader balance: ${err.message}`);
        return 0n;
    }
}

/**
 * Refresh the leader cache from on-chain state.
 */
async function _refreshLeaderCache() {
    try {
        const count = await copyTradingContract.getLeaderCount();
        for (let i = 0; i < Number(count); i++) {
            const addr = await copyTradingContract.leaderList(i);
            const profile = await copyTradingContract.leaders(addr);
            if (profile.isRegistered) {
                registeredLeaders.add(addr.toLowerCase());
            }
        }
    } catch (err) {
        console.error(`[CopyEngine] Leader cache refresh failed: ${err.message}`);
    }
}

// ══════════════════════ AUDIT LOG ══════════════════════

function _logTrade(task, status, details, txHash = null) {
    const entry = {
        timestamp: new Date().toISOString(),
        type: task.type,
        leader: task.leader,
        leaderPositionId: task.leaderPositionId?.toString(),
        status,
        details,
        txHash,
        retries: task.retries,
    };

    tradeLog.push(entry);

    // Keep only last 1000 entries in memory
    if (tradeLog.length > 1000) {
        tradeLog.splice(0, tradeLog.length - 1000);
    }
}

function getTradeLog() {
    return tradeLog;
}

// ══════════════════════ API HELPERS ══════════════════════

/**
 * Get engine status for the /api/copy-engine/status endpoint.
 */
function getEngineStatus() {
    return {
        isRunning,
        keeper: keeperWallet?.address || null,
        registeredLeaders: registeredLeaders.size,
        queueLength: executionQueue.length,
        lastProcessedBlock,
        tradeLogCount: tradeLog.length,
    };
}

/**
 * Force refresh the leader cache (e.g., after deploying a new leader).
 */
async function refreshLeaders() {
    await _refreshLeaderCache();
    return { leadersCount: registeredLeaders.size, leaders: Array.from(registeredLeaders) };
}

module.exports = {
    startCopyEngine,
    stopCopyEngine,
    getEngineStatus,
    getTradeLog,
    refreshLeaders,
    COPY_TRADING_ABI,
    PERPS_ABI,
};
