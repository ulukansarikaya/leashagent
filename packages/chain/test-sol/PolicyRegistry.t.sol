// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PolicyRegistry} from "../contracts/PolicyRegistry.sol";

contract PolicyRegistryTest is Test {
    PolicyRegistry reg;
    address owner = address(0xA11CE);
    address attacker = address(0xBAD);
    address agentRegistry = address(0x8004);
    address agentAuth = address(0xA9E47);
    bytes32 accountRef = keccak256("okx-demo-account-1");
    bytes32 h1 = keccak256("policy-v1");
    bytes32 h2 = keccak256("policy-v2");

    function setUp() public {
        reg = new PolicyRegistry();
    }

    function _create() internal returns (bytes32 id) {
        vm.prank(owner);
        id = reg.createPolicy(accountRef, agentRegistry, 42, agentAuth, uint64(block.timestamp + 1 days), h1, "ipfs://v1");
    }

    // ---------- shared test vector ----------

    function test_policyId_matchesSharedVector() public view {
        string memory json = vm.readFile("../shared/test-vectors.json");
        address vOwner = vm.parseJsonAddress(json, ".policyId.owner");
        bytes32 vRef = vm.parseJsonBytes32(json, ".policyId.accountRef");
        address vReg = vm.parseJsonAddress(json, ".policyId.agentRegistry");
        uint256 vId = vm.parseUint(vm.parseJsonString(json, ".policyId.agentRegistryId"));
        bytes32 expected = vm.parseJsonBytes32(json, ".policyId.expected");
        assertEq(vRef, keccak256(bytes(vm.parseJsonString(json, ".policyId.accountIdentifier"))));
        assertEq(reg.computePolicyId(vOwner, vRef, vReg, vId), expected);
    }

    // ---------- create ----------

    function test_create_storesRecordAndEmits() public {
        bytes32 expectedId = reg.computePolicyId(owner, accountRef, agentRegistry, 42);
        vm.expectEmit(true, true, false, false);
        emit PolicyRegistry.PolicyCreated(expectedId, owner);
        bytes32 id = _create();
        assertEq(id, expectedId);

        PolicyRegistry.PolicyRecord memory p = reg.getPolicy(id);
        assertEq(p.owner, owner);
        assertEq(p.accountRef, accountRef);
        assertEq(p.agentRegistry, agentRegistry);
        assertEq(p.agentRegistryId, 42);
        assertEq(p.agentAuthAddress, agentAuth);
        assertEq(p.policyHash, h1);
        assertEq(p.version, 1);
        assertFalse(p.revoked);
        assertFalse(p.paused);
    }

    function test_create_duplicateReverts() public {
        bytes32 id = _create();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.PolicyExists.selector, id));
        reg.createPolicy(accountRef, agentRegistry, 42, agentAuth, 0, h2, "");
    }

    function test_create_sameBindingDifferentOwner_isDifferentPolicy() public {
        bytes32 id = _create();
        vm.prank(attacker);
        bytes32 id2 = reg.createPolicy(accountRef, agentRegistry, 42, attacker, 0, h2, "");
        assertTrue(id != id2);
        assertEq(reg.getPolicy(id).agentAuthAddress, agentAuth); // original untouched
    }

    function test_create_zeroValuesRevert() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.ZeroValue.selector, "accountRef"));
        reg.createPolicy(bytes32(0), agentRegistry, 42, agentAuth, 0, h1, "");
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.ZeroValue.selector, "agentRegistry"));
        reg.createPolicy(accountRef, address(0), 42, agentAuth, 0, h1, "");
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.ZeroValue.selector, "agentAuthAddress"));
        reg.createPolicy(accountRef, agentRegistry, 42, address(0), 0, h1, "");
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.ZeroValue.selector, "policyHash"));
        reg.createPolicy(accountRef, agentRegistry, 42, agentAuth, 0, bytes32(0), "");
        vm.stopPrank();
    }

    function test_getPolicy_unknownReverts() public {
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.UnknownPolicy.selector, bytes32(uint256(1))));
        reg.getPolicy(bytes32(uint256(1)));
    }

    // ---------- setPolicy ----------

    function test_setPolicy_bumpsVersion() public {
        bytes32 id = _create();
        vm.prank(owner);
        reg.setPolicy(id, h2, "ipfs://v2", 1);
        PolicyRegistry.PolicyRecord memory p = reg.getPolicy(id);
        assertEq(p.policyHash, h2);
        assertEq(p.version, 2);
        assertEq(p.policyURI, "ipfs://v2");
    }

    function test_setPolicy_staleVersionReverts() public {
        bytes32 id = _create();
        vm.startPrank(owner);
        reg.setPolicy(id, h2, "", 1);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.VersionMismatch.selector, 1, 2));
        reg.setPolicy(id, h1, "", 1);
        vm.stopPrank();
    }

    function test_setPolicy_zeroHashReverts() public {
        bytes32 id = _create();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.ZeroValue.selector, "policyHash"));
        reg.setPolicy(id, bytes32(0), "", 1);
    }

    // ---------- owner-only ----------

    function test_nonOwner_cannotMutate() public {
        bytes32 id = _create();
        vm.startPrank(attacker);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.NotOwner.selector, id, attacker));
        reg.setPolicy(id, h2, "", 1);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.NotOwner.selector, id, attacker));
        reg.setDelegation(id, attacker, type(uint64).max, false);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.NotOwner.selector, id, attacker));
        reg.setPaused(id, false);
        vm.stopPrank();
    }

    function test_unknownPolicy_mutationsRevert() public {
        bytes32 bogus = keccak256("nope");
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.UnknownPolicy.selector, bogus));
        reg.setPaused(bogus, true);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.UnknownPolicy.selector, bogus));
        reg.setDelegation(bogus, agentAuth, 0, false);
        vm.stopPrank();
    }

    // ---------- delegation / pause ----------

    function test_setDelegation_revokeAndRotate() public {
        bytes32 id = _create();
        vm.startPrank(owner);
        vm.expectEmit(true, false, false, true);
        emit PolicyRegistry.DelegationChanged(id, agentAuth, 0, true);
        reg.setDelegation(id, agentAuth, 0, true);
        assertTrue(reg.getPolicy(id).revoked);

        address newAuth = address(0xBEEF);
        reg.setDelegation(id, newAuth, 123, false);
        PolicyRegistry.PolicyRecord memory p = reg.getPolicy(id);
        assertEq(p.agentAuthAddress, newAuth);
        assertEq(p.delegationExpiresAt, 123);
        assertFalse(p.revoked);

        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.ZeroValue.selector, "agentAuthAddress"));
        reg.setDelegation(id, address(0), 0, false);
        vm.stopPrank();
    }

    function test_setPaused_togglesAndEmits() public {
        bytes32 id = _create();
        vm.startPrank(owner);
        vm.expectEmit(true, false, false, true);
        emit PolicyRegistry.PausedChanged(id, true);
        reg.setPaused(id, true);
        assertTrue(reg.getPolicy(id).paused);
        reg.setPaused(id, false);
        assertFalse(reg.getPolicy(id).paused);
        vm.stopPrank();
    }

    function testFuzz_policyIdIsInjective(address o, bytes32 r, address a, uint256 i) public view {
        vm.assume(o != owner);
        assertTrue(reg.computePolicyId(o, r, a, i) != reg.computePolicyId(owner, r, a, i));
    }
}
