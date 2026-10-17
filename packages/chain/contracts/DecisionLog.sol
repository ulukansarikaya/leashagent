// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DecisionLog — hash-only evidence of Bekçi decisions and execution events (SONPLAN.md §7).
/// @dev Evidence, not dependency (P9): the gateway never waits on this contract to decide.
///      `ExecutionLogged` records what the gateway observed; it does not prove an OKX fill.
contract DecisionLog {
    // Enum order is frozen and mirrored by shared CHAIN_VERDICTS / EXEC_STATUSES.
    enum Verdict { Allow, Block, Pending, HumanApproved, HumanRejected }
    enum ExecStatus { Submitted, Acknowledged, Filled, PartiallyFilled, Cancelled, RejectedByOkx, Expired, Revoked, Unknown }

    event DecisionLogged(
        bytes32 indexed policyId,
        bytes32 indexed requestId,
        Verdict verdict,
        bytes32 policyHash,
        uint64 policyVersion,
        bytes32 normalizedOrderHash,
        bytes32 evidenceHash,
        uint16 reasonCode,
        bytes32 authHash
    );
    event ExecutionLogged(bytes32 indexed requestId, uint32 eventSeq, ExecStatus status, bytes32 okxResultHash);
    event LoggerSet(address indexed logger, bool enabled);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotLogger();
    error ZeroAddress();
    error PolicyMismatch(bytes32 requestId);
    error InvalidDecisionTransition(bytes32 requestId);
    error NoExecutableDecision(bytes32 requestId);
    error BadEventSeq(uint32 expected, uint32 got);
    error InvalidExecTransition(bytes32 requestId);

    struct RequestState {
        bytes32 policyId;
        uint8 decision; // 0 = none, else uint8(Verdict) + 1
        uint8 exec; // 0 = none, else uint8(ExecStatus) + 1
        uint32 lastSeq;
    }

    address public owner;
    mapping(address => bool) public isLogger;
    mapping(bytes32 => RequestState) private _requests;

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyLogger() {
        if (!isLogger[msg.sender]) revert NotLogger();
        _;
    }

    function setLogger(address logger, bool enabled) external onlyOwner {
        if (logger == address(0)) revert ZeroAddress();
        isLogger[logger] = enabled;
        emit LoggerSet(logger, enabled);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Decision transitions: none → Allow|Block|Pending; Pending → HumanApproved|HumanRejected|Block.
    ///         Everything else is terminal.
    function logDecision(
        bytes32 policyId,
        bytes32 requestId,
        Verdict verdict,
        bytes32 policyHash,
        uint64 policyVersion,
        bytes32 normalizedOrderHash,
        bytes32 evidenceHash,
        uint16 reasonCode,
        bytes32 authHash
    ) external onlyLogger {
        RequestState storage r = _requests[requestId];
        if (r.decision == 0) {
            if (verdict != Verdict.Allow && verdict != Verdict.Block && verdict != Verdict.Pending) {
                revert InvalidDecisionTransition(requestId);
            }
            r.policyId = policyId;
        } else {
            if (r.policyId != policyId) revert PolicyMismatch(requestId);
            if (r.decision != uint8(Verdict.Pending) + 1) revert InvalidDecisionTransition(requestId);
            if (verdict != Verdict.HumanApproved && verdict != Verdict.HumanRejected && verdict != Verdict.Block) {
                revert InvalidDecisionTransition(requestId);
            }
        }
        r.decision = uint8(verdict) + 1;
        emit DecisionLogged(
            policyId, requestId, verdict, policyHash, policyVersion, normalizedOrderHash, evidenceHash, reasonCode, authHash
        );
    }

    function logExecution(bytes32 requestId, uint32 eventSeq, ExecStatus status, bytes32 okxResultHash)
        external
        onlyLogger
    {
        RequestState storage r = _requests[requestId];
        if (r.decision != uint8(Verdict.Allow) + 1 && r.decision != uint8(Verdict.HumanApproved) + 1) {
            revert NoExecutableDecision(requestId);
        }
        if (eventSeq != r.lastSeq + 1) revert BadEventSeq(r.lastSeq + 1, eventSeq);
        if (!isExecTransitionAllowed(r.exec, status)) revert InvalidExecTransition(requestId);
        r.lastSeq = eventSeq;
        r.exec = uint8(status) + 1;
        emit ExecutionLogged(requestId, eventSeq, status, okxResultHash);
    }

    /// @param prev 0 = no event yet, else uint8(ExecStatus) + 1. Mirrored by shared EXEC_TRANSITIONS.
    function isExecTransitionAllowed(uint8 prev, ExecStatus next) public pure returns (bool) {
        return (_allowedMask(prev) >> uint8(next)) & 1 == 1;
    }

    function _allowedMask(uint8 prev) private pure returns (uint16) {
        uint16 SUB = uint16(1) << uint8(ExecStatus.Submitted);
        uint16 ACK = uint16(1) << uint8(ExecStatus.Acknowledged);
        uint16 FIL = uint16(1) << uint8(ExecStatus.Filled);
        uint16 PAR = uint16(1) << uint8(ExecStatus.PartiallyFilled);
        uint16 CAN = uint16(1) << uint8(ExecStatus.Cancelled);
        uint16 REJ = uint16(1) << uint8(ExecStatus.RejectedByOkx);
        uint16 EXP = uint16(1) << uint8(ExecStatus.Expired);
        uint16 REV = uint16(1) << uint8(ExecStatus.Revoked);
        uint16 UNK = uint16(1) << uint8(ExecStatus.Unknown);

        if (prev == 0) return SUB | ACK | REJ | UNK | EXP | REV;
        ExecStatus p = ExecStatus(prev - 1);
        if (p == ExecStatus.Submitted) return ACK | FIL | PAR | CAN | REJ | UNK;
        if (p == ExecStatus.Unknown) return ACK | FIL | PAR | CAN | REJ;
        if (p == ExecStatus.Acknowledged) return FIL | PAR | CAN;
        if (p == ExecStatus.PartiallyFilled) return PAR | FIL | CAN;
        return 0; // Filled, Cancelled, RejectedByOkx, Expired, Revoked are terminal
    }

    function requestState(bytes32 requestId)
        external
        view
        returns (bytes32 policyId, uint8 decision, uint8 exec, uint32 lastSeq)
    {
        RequestState storage r = _requests[requestId];
        return (r.policyId, r.decision, r.exec, r.lastSeq);
    }
}
