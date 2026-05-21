// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AuraAuditTrail
 * @author Aura Protocol
 * @notice On-chain audit trail for AI agent reasoning. Before every execution,
 *         the agent records a hash of its reasoning (executor + risk auditor +
 *         macro analysis) so that the decision process is verifiable on-chain.
 */
contract AuraAuditTrail {
    event ReasoningRecorded(
        address indexed agent,
        address indexed user,
        bytes32 reasoningHash,
        uint256 timestamp,
        string action
    );

    /// @notice Record the hash of the AI committee's reasoning before execution.
    /// @param user The user whose trade is being executed.
    /// @param reasoningHash keccak256 of the JSON-serialized audit + macro analysis.
    /// @param action Short description (e.g. "SWAP ETH→AMZN" or "LIMIT_ORDER BTC 10x").
    function recordReasoning(
        address user,
        bytes32 reasoningHash,
        string calldata action
    ) external {
        emit ReasoningRecorded(msg.sender, user, reasoningHash, block.timestamp, action);
    }
}
