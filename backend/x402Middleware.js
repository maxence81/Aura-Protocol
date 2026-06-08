import { createPublicClient, http } from 'viem';

// Configuration x402
const RPC_URL = process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || "0x4Ae6Ab5BCAb4F0f2FAcAA47aD2ea5832eBDF5792"; // Utilise le Vault par défaut si non défini
const AUSD_ADDRESS = process.env.AUSD_ADDRESS || "0x0000000000000000000000000000000000000000"; // À remplacer par la vraie adresse
const PAYMENT_AMOUNT = 1n * 10n ** 18n; // Exemple: 1 aUSD (18 décimales)

const publicClient = createPublicClient({
  transport: http(RPC_URL)
});

// Cache en mémoire pour éviter les re-vérifications inutiles (1 heure)
const verifiedTxs = new Map();

/**
 * Vérifie si le txHash fourni correspond à un paiement valide
 * @param {string} txHash Le hash de la transaction
 * @returns {Promise<boolean>}
 */
export async function verifyX402Payment(txHash) {
    if (!txHash || typeof txHash !== 'string' || !txHash.startsWith('0x')) {
        return false;
    }

    // Vérification du cache
    if (verifiedTxs.has(txHash)) {
        const timestamp = verifiedTxs.get(txHash);
        if (Date.now() - timestamp < 3600000) { // Validité d'une heure
            return true;
        } else {
            verifiedTxs.delete(txHash);
        }
    }

    try {
        const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
        
        // Vérifier si la transaction a réussi
        if (receipt.status !== 'success') return false;

        // Signature de l'événement Transfer(address,address,uint256)
        const transferEventSig = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

        let isValidPayment = false;

        for (const log of receipt.logs) {
            // Vérifie que le contrat est bien aUSD
            if (log.address.toLowerCase() === AUSD_ADDRESS.toLowerCase() && log.topics[0] === transferEventSig) {
                // L'adresse de destination est le 3ème topic
                const toAddress = `0x${log.topics[2].slice(26)}`;
                
                if (toAddress.toLowerCase() === TREASURY_ADDRESS.toLowerCase()) {
                    const amount = BigInt(log.data);
                    // Vérifie que le montant est suffisant
                    if (amount >= PAYMENT_AMOUNT) {
                        isValidPayment = true;
                        break;
                    }
                }
            }
        }

        // Si c'est valide, on ajoute au cache
        if (isValidPayment) {
            verifiedTxs.set(txHash, Date.now());
            return true;
        }

        return false;
    } catch (error) {
        console.error("[x402] Payment verification failed for tx:", txHash, error.message);
        return false;
    }
}

/**
 * Génère une réponse d'erreur 402 structurée
 */
export function createX402Response() {
    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                status: 402,
                message: "Payment Required - x402 Standard",
                payment_address: TREASURY_ADDRESS,
                amount: PAYMENT_AMOUNT.toString(),
                currency: "aUSD",
                tx_hash_verifier: "Include 'payment_tx_hash' in your next tool call arguments.",
                instruction: `You must pay ${Number(PAYMENT_AMOUNT) / 1e18} aUSD to access this premium tool. Please sign a transaction sending the funds to ${TREASURY_ADDRESS} and retry this tool with the argument payment_tx_hash.`
            }, null, 2)
        }],
        isError: true // Marque l'appel d'outil comme une erreur au niveau du protocole MCP
    };
}

/**
 * Wrapper de fonction pour protéger les outils MCP avec la norme x402
 * @param {Function} handler Le handler original de l'outil
 */
export function withX402(handler) {
    return async (args) => {
        const { payment_tx_hash, ...restArgs } = args;

        const isPaid = await verifyX402Payment(payment_tx_hash);
        
        if (!isPaid) {
            return createX402Response();
        }

        // Si le paiement est valide, on exécute la logique normale
        return handler(restArgs);
    };
}
