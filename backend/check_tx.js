const { ethers } = require('ethers');

async function main() {
    const provider = new ethers.JsonRpcProvider('https://sepolia-rollup.arbitrum.io/rpc');
    const hash = '0xdb153258284e7eacc1b2d7e8aa49533074d03dd580d0336716b8c7c941b9e4c9';
    const tx = await provider.getTransaction(hash);
    console.log("TX:", tx.from, tx.to, tx.data.substring(0, 10));
    
    // get receipt to see if it reverted
    const receipt = await provider.getTransactionReceipt(hash);
    console.log("STATUS:", receipt.status);

    // Let's check allowance of tx.from to Escrow
    const abi = ["function allowance(address, address) view returns (uint256)"];
    const ausd = new ethers.Contract('0x27cd6eD9482FF6Ae388F629E8E6D57d8dc975c5A', abi, provider);
    const allow = await ausd.allowance(tx.from, '0xe133eab3114bcd18c169e97c81af1d2654e5a3ff');
    console.log("ALLOWANCE:", allow.toString());
}
main();
