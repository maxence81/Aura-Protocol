const { ethers } = require("ethers");
const OriginalJsonRpcProvider = ethers.JsonRpcProvider;

const requestQueue = [];
let isProcessingQueue = false;

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    while (requestQueue.length > 0) {
        const { payload, resolve, reject, _super, instance } = requestQueue.shift();
        try {
            const result = await _super.call(instance, payload);
            resolve(result);
        } catch (e) {
            reject(e);
        }
        // Wait ~200ms between requests (approx 5 req/sec per process)
        // Since there are multiple processes (index.js, lobKeeper), 5 req/s * 2 = 10 req/s (safely below 15/s)
        await new Promise(r => setTimeout(r, 200));
    }
    isProcessingQueue = false;
}

ethers.JsonRpcProvider = class extends OriginalJsonRpcProvider {
    constructor(...args) {
        super(...args);
        // Override polling interval to 60s to avoid spamming the RPC
        this.pollingInterval = 60000;
    }

    async _send(payload) {
        return new Promise((resolve, reject) => {
            requestQueue.push({
                payload,
                resolve,
                reject,
                _super: OriginalJsonRpcProvider.prototype._send,
                instance: this
            });
            processQueue();
        });
    }
};

module.exports = true;
