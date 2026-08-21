// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title Receiver
/// @notice Destination-chain counterpart to Escrow. Deployed on a SEPARATE
///         chain (e.g. Base Sepolia) from Escrow (e.g. Ethereum Sepolia).
///
///         The oracle service acts as a relayer: after observing a lock()
///         on the source chain's Escrow, it submits a real transaction here
///         calling deliver(). This contract performs genuine on-chain
///         validation and can genuinely revert (zero recipient, blocked
///         recipient, double delivery). The oracle then reports back to
///         Escrow based on whether THIS transaction actually succeeded or
///         reverted on THIS independent chain — not based on an off-chain
///         string comparison.
///
/// @dev    This still does not make the system a fully decentralized
///         bridge — the oracle/relayer is a single trusted process, same
///         caveat as before. What's changed is that "did delivery succeed"
///         is now answered by real state on a second chain, not simulated.
contract Receiver is Ownable {
    mapping(address => bool) public isRelayer;
    mapping(uint256 => bool) public delivered;

    /// @dev Well-known "burn" address, used here as a genuine on-chain
    ///      guard so failure demos are real reverts, not scripted checks.
    address public constant BLOCKED_RECIPIENT = 0x000000000000000000000000000000000000dEaD;

    event RelayerUpdated(address indexed relayer, bool allowed);
    event Delivered(
        uint256 indexed transferId,
        address indexed recipient,
        uint256 amount,
        uint256 indexed sourceChainId
    );

    modifier onlyRelayer() {
        require(isRelayer[msg.sender], "Receiver: caller is not a relayer");
        _;
    }

    constructor(address initialRelayer) Ownable(msg.sender) {
        if (initialRelayer != address(0)) {
            isRelayer[initialRelayer] = true;
            emit RelayerUpdated(initialRelayer, true);
        }
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        isRelayer[relayer] = allowed;
        emit RelayerUpdated(relayer, allowed);
    }

    /// @notice Called by the oracle/relayer after observing a lock() on the
    ///         source chain's Escrow. Reverts for real, on-chain, if the
    ///         delivery is invalid — the oracle is meant to catch that
    ///         revert and report failure back to Escrow, rather than
    ///         deciding success/failure itself off-chain.
    function deliver(
        uint256 transferId,
        address recipient,
        uint256 amount,
        uint256 sourceChainId
    ) external onlyRelayer {
        require(recipient != address(0), "Receiver: zero recipient");
        require(recipient != BLOCKED_RECIPIENT, "Receiver: recipient blocked");
        require(amount > 0, "Receiver: zero amount");
        require(!delivered[transferId], "Receiver: already delivered");

        delivered[transferId] = true;
        emit Delivered(transferId, recipient, amount, sourceChainId);
    }

    function wasDelivered(uint256 transferId) external view returns (bool) {
        return delivered[transferId];
    }
}
