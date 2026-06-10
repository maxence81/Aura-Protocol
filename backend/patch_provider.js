const originalFetch = global.fetch;

const rpcQueue = [];
let isProcessingRpc = false;

async function processRpcQueue() {
    if (isProcessingRpc) return;
    isProcessingRpc = true;
    while (rpcQueue.length > 0) {
        const { url, options, resolve, reject } = rpcQueue.shift();
        try {
            const res = await originalFetch(url, options);
            resolve(res);
        } catch (err) {
            reject(err);
        }
        // Wait 250ms between requests to ensure max 4 requests/sec per instance (8 total)
        await new Promise(r => setTimeout(r, 250));
    }
    isProcessingRpc = false;
}

global.fetch = async function(url, options) {
    let urlString = "";
    if (typeof url === 'string') urlString = url;
    else if (url && url.url) urlString = url.url;

    // Check if it's the Robinhood RPC or any QuickNode RPC
    if (urlString.includes("robinhood.com") || urlString.includes("quiknode") || urlString.includes("quicknode")) {
        return new Promise((resolve, reject) => {
            rpcQueue.push({ url, options, resolve, reject });
            processRpcQueue();
        });
    }

    return originalFetch(url, options);
};

// We also keep the ethers patch just in case, but fetch is foolproof
const { ethers } = require("ethers");
if (ethers && ethers.JsonRpcProvider) {
    const OriginalJsonRpcProvider = ethers.JsonRpcProvider;
    ethers.JsonRpcProvider = class extends OriginalJsonRpcProvider {
        constructor(...args) {
            super(...args);
            this.pollingInterval = 60000;
        }
    };
}

module.exports = true;
