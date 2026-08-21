// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Escrow
/// @notice Opt-in escrow for cross-chain transfers. Funds are locked on the
///         source chain and only released to the recipient once a
///         (mocked, centralized-for-demo) oracle confirms delivery on the
///         destination chain, or refunded to the sender on timeout/failure.
/// @dev    THIS DOES NOT AND CANNOT RECOVER FUNDS SENT OUTSIDE THIS CONTRACT.
///         It only protects transfers that were routed through `lock()`.
contract Escrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Locked,
        Confirmed,
        Refunded
    }

    struct Transfer {
        address sender;
        address recipient;
        address token; // address(0) == native currency
        uint256 amount;
        uint256 destinationChainId;
        uint256 createdAt;
        uint256 timeoutSeconds;
        Status status;
    }

    /// @notice addresses allowed to call confirmDelivery / reportFailure
    mapping(address => bool) public isOracle;

    mapping(uint256 => Transfer) public transfers;
    uint256 public nextTransferId = 1;

    uint256 public constant MIN_TIMEOUT = 5 minutes;
    uint256 public constant MAX_TIMEOUT = 7 days;

    event OracleUpdated(address indexed oracle, bool allowed);

    event TransferLocked(
        uint256 indexed transferId,
        address indexed sender,
        address indexed recipient,
        address token,
        uint256 amount,
        uint256 destinationChainId,
        uint256 timeoutSeconds
    );

    event TransferConfirmed(uint256 indexed transferId, address indexed recipient, uint256 amount);
    event TransferRefunded(uint256 indexed transferId, address indexed sender, uint256 amount, string reason);

    modifier onlyOracle() {
        require(isOracle[msg.sender], "Escrow: caller is not an oracle");
        _;
    }

    constructor(address initialOracle) Ownable(msg.sender) {
        if (initialOracle != address(0)) {
            isOracle[initialOracle] = true;
            emit OracleUpdated(initialOracle, true);
        }
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    function setOracle(address oracle, bool allowed) external onlyOwner {
        isOracle[oracle] = allowed;
        emit OracleUpdated(oracle, allowed);
    }

    // ---------------------------------------------------------------
    // Core flow: lock -> confirmDelivery | refund/reportFailure
    // ---------------------------------------------------------------

    /// @notice Lock native currency or an ERC20 token for a cross-chain transfer.
    /// @param destinationChainId Chain id the funds are ultimately destined for
    ///        (informational for the oracle's off-chain checks; this contract
    ///        itself only ever lives on the source chain).
    /// @param recipient Address to release funds to once confirmed.
    /// @param token address(0) for native currency, otherwise an ERC20 address.
    /// @param amount Amount to lock. For native currency this must equal msg.value.
    /// @param timeoutSeconds How long to wait before the sender can self-refund
    ///        if no oracle confirmation/failure report arrives.
    function lock(
        uint256 destinationChainId,
        address recipient,
        address token,
        uint256 amount,
        uint256 timeoutSeconds
    ) external payable nonReentrant returns (uint256 transferId) {
        require(recipient != address(0), "Escrow: recipient is zero address");
        require(amount > 0, "Escrow: amount must be > 0");
        require(timeoutSeconds >= MIN_TIMEOUT && timeoutSeconds <= MAX_TIMEOUT, "Escrow: timeout out of range");

        if (token == address(0)) {
            require(msg.value == amount, "Escrow: msg.value must equal amount for native transfers");
        } else {
            require(msg.value == 0, "Escrow: do not send native value with an ERC20 lock");
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }

        transferId = nextTransferId++;
        transfers[transferId] = Transfer({
            sender: msg.sender,
            recipient: recipient,
            token: token,
            amount: amount,
            destinationChainId: destinationChainId,
            createdAt: block.timestamp,
            timeoutSeconds: timeoutSeconds,
            status: Status.Locked
        });

        emit TransferLocked(transferId, msg.sender, recipient, token, amount, destinationChainId, timeoutSeconds);
    }

    /// @notice Called by an authorized oracle once destination-chain execution
    ///         has been confirmed. Releases locked funds to the recipient.
    function confirmDelivery(uint256 transferId) external onlyOracle nonReentrant {
        Transfer storage t = transfers[transferId];
        require(t.status == Status.Locked, "Escrow: transfer not in Locked state");

        t.status = Status.Confirmed;
        _payOut(t.token, t.recipient, t.amount);

        emit TransferConfirmed(transferId, t.recipient, t.amount);
    }

    /// @notice Called by an authorized oracle if destination-chain execution is
    ///         confirmed to have failed. Refunds the sender immediately,
    ///         without waiting for the timeout.
    function reportFailure(uint256 transferId) external onlyOracle nonReentrant {
        Transfer storage t = transfers[transferId];
        require(t.status == Status.Locked, "Escrow: transfer not in Locked state");

        t.status = Status.Refunded;
        _payOut(t.token, t.sender, t.amount);

        emit TransferRefunded(transferId, t.sender, t.amount, "oracle-reported-failure");
    }

    /// @notice Anyone can trigger this once the timeout has elapsed with no
    ///         oracle confirmation or failure report. Protects the sender if
    ///         the oracle service is down or unresponsive.
    function refundOnTimeout(uint256 transferId) external nonReentrant {
        Transfer storage t = transfers[transferId];
        require(t.status == Status.Locked, "Escrow: transfer not in Locked state");
        require(block.timestamp >= t.createdAt + t.timeoutSeconds, "Escrow: timeout not yet elapsed");

        t.status = Status.Refunded;
        _payOut(t.token, t.sender, t.amount);

        emit TransferRefunded(transferId, t.sender, t.amount, "timeout-elapsed");
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    function getTransfer(uint256 transferId) external view returns (Transfer memory) {
        return transfers[transferId];
    }

    function timeRemaining(uint256 transferId) external view returns (uint256) {
        Transfer storage t = transfers[transferId];
        uint256 deadline = t.createdAt + t.timeoutSeconds;
        if (block.timestamp >= deadline) return 0;
        return deadline - block.timestamp;
    }

    // ---------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------

    function _payOut(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            require(ok, "Escrow: native transfer failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    receive() external payable {
        revert("Escrow: use lock() to deposit funds");
    }
}
