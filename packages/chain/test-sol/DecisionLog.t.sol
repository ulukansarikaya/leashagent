// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DecisionLog} from "../contracts/DecisionLog.sol";

contract DecisionLogTest is Test {
    DecisionLog dlog;
    address owner = address(0xA11CE);
    address logger = address(0x1066E2);
    address attacker = address(0xBAD);
    bytes32 pid = keccak256("policy");
    bytes32 rid = keccak256("123e4567-e89b-42d3-a456-426614174000");

    function setUp() public {
        dlog = new DecisionLog(owner);
        vm.prank(owner);
        dlog.setLogger(logger, true);
    }

    function _decide(bytes32 r, DecisionLog.Verdict v) internal {
        vm.prank(logger);
        dlog.logDecision(pid, r, v, keccak256("ph"), 1, keccak256("order"), keccak256("ev"), 0, keccak256("auth"));
    }

    function _exec(bytes32 r, uint32 seq, DecisionLog.ExecStatus s) internal {
        vm.prank(logger);
        dlog.logExecution(r, seq, s, keccak256(abi.encode(seq)));
    }

    // ---------- roles ----------

    function test_onlyLogger() public {
        vm.prank(attacker);
        vm.expectRevert(DecisionLog.NotLogger.selector);
        dlog.logDecision(pid, rid, DecisionLog.Verdict.Allow, 0, 1, 0, 0, 0, 0);
        vm.prank(attacker);
        vm.expectRevert(DecisionLog.NotLogger.selector);
        dlog.logExecution(rid, 1, DecisionLog.ExecStatus.Submitted, 0);
    }

    function test_onlyOwnerManagesLoggers() public {
        vm.prank(attacker);
        vm.expectRevert(DecisionLog.NotOwner.selector);
        dlog.setLogger(attacker, true);

        vm.prank(owner);
        dlog.setLogger(logger, false);
        vm.prank(logger);
        vm.expectRevert(DecisionLog.NotLogger.selector);
        dlog.logDecision(pid, rid, DecisionLog.Verdict.Allow, 0, 1, 0, 0, 0, 0);
    }

    function test_transferOwnership() public {
        vm.prank(owner);
        dlog.transferOwnership(attacker);
        assertEq(dlog.owner(), attacker);
        vm.prank(owner);
        vm.expectRevert(DecisionLog.NotOwner.selector);
        dlog.setLogger(owner, true);
    }

    function test_zeroAddressesRevert() public {
        vm.expectRevert(DecisionLog.ZeroAddress.selector);
        new DecisionLog(address(0));
        vm.startPrank(owner);
        vm.expectRevert(DecisionLog.ZeroAddress.selector);
        dlog.setLogger(address(0), true);
        vm.expectRevert(DecisionLog.ZeroAddress.selector);
        dlog.transferOwnership(address(0));
        vm.stopPrank();
    }

    // ---------- decisions ----------

    function test_decision_emits() public {
        vm.expectEmit(true, true, false, true);
        emit DecisionLog.DecisionLogged(
            pid, rid, DecisionLog.Verdict.Allow, keccak256("ph"), 1, keccak256("order"), keccak256("ev"), 0, keccak256("auth")
        );
        _decide(rid, DecisionLog.Verdict.Allow);
    }

    function test_decision_duplicateReverts() public {
        _decide(rid, DecisionLog.Verdict.Allow);
        vm.prank(logger);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.InvalidDecisionTransition.selector, rid));
        dlog.logDecision(pid, rid, DecisionLog.Verdict.Allow, 0, 1, 0, 0, 0, 0);
    }

    function test_decision_blockIsTerminal() public {
        _decide(rid, DecisionLog.Verdict.Block);
        vm.prank(logger);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.InvalidDecisionTransition.selector, rid));
        dlog.logDecision(pid, rid, DecisionLog.Verdict.HumanApproved, 0, 1, 0, 0, 0, 0);
    }

    function test_decision_humanVerdictRequiresPending() public {
        vm.prank(logger);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.InvalidDecisionTransition.selector, rid));
        dlog.logDecision(pid, rid, DecisionLog.Verdict.HumanApproved, 0, 1, 0, 0, 0, 0);
        vm.prank(logger);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.InvalidDecisionTransition.selector, rid));
        dlog.logDecision(pid, rid, DecisionLog.Verdict.HumanRejected, 0, 1, 0, 0, 0, 0);
    }

    function test_decision_pendingPaths() public {
        bytes32 r1 = keccak256("r1");
        bytes32 r2 = keccak256("r2");
        bytes32 r3 = keccak256("r3");
        _decide(r1, DecisionLog.Verdict.Pending);
        _decide(r1, DecisionLog.Verdict.HumanApproved);
        _decide(r2, DecisionLog.Verdict.Pending);
        _decide(r2, DecisionLog.Verdict.HumanRejected);
        _decide(r3, DecisionLog.Verdict.Pending);
        _decide(r3, DecisionLog.Verdict.Block); // expired / re-check failed

        vm.prank(logger);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.InvalidDecisionTransition.selector, r1));
        dlog.logDecision(pid, r1, DecisionLog.Verdict.HumanRejected, 0, 1, 0, 0, 0, 0);
    }

    function test_decision_pendingCannotBecomeAllowDirectly() public {
        _decide(rid, DecisionLog.Verdict.Pending);
        vm.prank(logger);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.InvalidDecisionTransition.selector, rid));
        dlog.logDecision(pid, rid, DecisionLog.Verdict.Allow, 0, 1, 0, 0, 0, 0);
    }

    function test_decision_policyMismatchReverts() public {
        _decide(rid, DecisionLog.Verdict.Pending);
        vm.prank(logger);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.PolicyMismatch.selector, rid));
        dlog.logDecision(keccak256("other"), rid, DecisionLog.Verdict.HumanApproved, 0, 1, 0, 0, 0, 0);
    }

    // ---------- executions ----------

    function test_exec_requiresExecutableDecision() public {
        vm.prank(logger);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.NoExecutableDecision.selector, rid));
        dlog.logExecution(rid, 1, DecisionLog.ExecStatus.Submitted, 0);

        _decide(rid, DecisionLog.Verdict.Block);
        vm.prank(logger);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.NoExecutableDecision.selector, rid));
        dlog.logExecution(rid, 1, DecisionLog.ExecStatus.Submitted, 0);
    }

    function test_exec_pendingNotExecutable() public {
        _decide(rid, DecisionLog.Verdict.Pending);
        vm.prank(logger);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.NoExecutableDecision.selector, rid));
        dlog.logExecution(rid, 1, DecisionLog.ExecStatus.Submitted, 0);
    }

    function test_exec_happyPath() public {
        _decide(rid, DecisionLog.Verdict.Allow);
        _exec(rid, 1, DecisionLog.ExecStatus.Submitted);
        _exec(rid, 2, DecisionLog.ExecStatus.Acknowledged);
        _exec(rid, 3, DecisionLog.ExecStatus.PartiallyFilled);
        _exec(rid, 4, DecisionLog.ExecStatus.PartiallyFilled);
        _exec(rid, 5, DecisionLog.ExecStatus.Filled);
        (bytes32 p,, uint8 ex, uint32 seq) = dlog.requestState(rid);
        assertEq(p, pid);
        assertEq(ex, uint8(DecisionLog.ExecStatus.Filled) + 1);
        assertEq(seq, 5);
    }

    function test_exec_humanApprovedExecutable() public {
        _decide(rid, DecisionLog.Verdict.Pending);
        _decide(rid, DecisionLog.Verdict.HumanApproved);
        _exec(rid, 1, DecisionLog.ExecStatus.Submitted);
    }

    function test_exec_unknownThenReconciled() public {
        _decide(rid, DecisionLog.Verdict.Allow);
        _exec(rid, 1, DecisionLog.ExecStatus.Submitted);
        _exec(rid, 2, DecisionLog.ExecStatus.Unknown);
        _exec(rid, 3, DecisionLog.ExecStatus.Filled);
    }

    function test_exec_badSeqReverts() public {
        _decide(rid, DecisionLog.Verdict.Allow);
        vm.prank(logger);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.BadEventSeq.selector, 1, 2));
        dlog.logExecution(rid, 2, DecisionLog.ExecStatus.Submitted, 0);

        _exec(rid, 1, DecisionLog.ExecStatus.Submitted);
        vm.prank(logger);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.BadEventSeq.selector, 2, 1));
        dlog.logExecution(rid, 1, DecisionLog.ExecStatus.Acknowledged, 0); // replayed seq
    }

    function test_exec_terminalStatesReject() public {
        _decide(rid, DecisionLog.Verdict.Allow);
        _exec(rid, 1, DecisionLog.ExecStatus.Submitted);
        _exec(rid, 2, DecisionLog.ExecStatus.Filled);
        vm.prank(logger);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.InvalidExecTransition.selector, rid));
        dlog.logExecution(rid, 3, DecisionLog.ExecStatus.Cancelled, 0);
    }

    function test_exec_invalidFirstEvent() public {
        _decide(rid, DecisionLog.Verdict.Allow);
        vm.prank(logger);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.InvalidExecTransition.selector, rid));
        dlog.logExecution(rid, 1, DecisionLog.ExecStatus.Filled, 0);
    }

    function test_exec_ackCannotGoBackToSubmitted() public {
        _decide(rid, DecisionLog.Verdict.Allow);
        _exec(rid, 1, DecisionLog.ExecStatus.Acknowledged);
        vm.prank(logger);
        vm.expectRevert(abi.encodeWithSelector(DecisionLog.InvalidExecTransition.selector, rid));
        dlog.logExecution(rid, 2, DecisionLog.ExecStatus.Submitted, 0);
    }

    /// Fuzz: whatever sequence of statuses we attempt, accepted transitions always respect the table
    /// and sequence numbers stay contiguous.
    function testFuzz_execNeverAcceptsDisallowed(uint8[8] memory raw) public {
        _decide(rid, DecisionLog.Verdict.Allow);
        uint8 prev = 0;
        uint32 seq = 0;
        for (uint256 i = 0; i < raw.length; i++) {
            DecisionLog.ExecStatus next = DecisionLog.ExecStatus(raw[i] % 9);
            bool ok = dlog.isExecTransitionAllowed(prev, next);
            vm.prank(logger);
            if (ok) {
                dlog.logExecution(rid, seq + 1, next, 0);
                seq++;
                prev = uint8(next) + 1;
            } else {
                vm.expectRevert(abi.encodeWithSelector(DecisionLog.InvalidExecTransition.selector, rid));
                dlog.logExecution(rid, seq + 1, next, 0);
            }
        }
        (,,, uint32 lastSeq) = dlog.requestState(rid);
        assertEq(lastSeq, seq);
    }
}
