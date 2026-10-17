// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PolicyRegistry — single source of truth for policy hash, version, ERC-8004 binding,
///        delegation and pause state (SONPLAN.md §7, §18). Only hashes and identity references live here.
contract PolicyRegistry {
    struct PolicyRecord {
        address owner;
        bytes32 accountRef;
        address agentRegistry;
        uint256 agentRegistryId;
        address agentAuthAddress;
        bytes32 policyHash; // keccak256(canonicalJson(policy))
        string policyURI;
        uint64 version;
        uint64 delegationExpiresAt;
        bool revoked;
        bool paused;
    }

    event PolicyCreated(bytes32 indexed policyId, address indexed owner);
    event PolicyUpdated(bytes32 indexed policyId, bytes32 policyHash, uint64 version);
    event DelegationChanged(bytes32 indexed policyId, address agentAuthAddress, uint64 expiresAt, bool revoked);
    event PausedChanged(bytes32 indexed policyId, bool paused);

    error PolicyExists(bytes32 policyId);
    error UnknownPolicy(bytes32 policyId);
    error NotOwner(bytes32 policyId, address caller);
    error VersionMismatch(uint64 expected, uint64 actual);
    error ZeroValue(string field);

    mapping(bytes32 => PolicyRecord) private _policies;

    /// @notice keccak256(abi.encode(owner, accountRef, agentRegistry, agentRegistryId)) — mirrors shared computePolicyId.
    function computePolicyId(address owner, bytes32 accountRef, address agentRegistry, uint256 agentRegistryId)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(owner, accountRef, agentRegistry, agentRegistryId));
    }

    function createPolicy(
        bytes32 accountRef,
        address agentRegistry,
        uint256 agentRegistryId,
        address agentAuthAddress,
        uint64 delegationExpiresAt,
        bytes32 policyHash,
        string calldata policyURI
    ) external returns (bytes32 policyId) {
        if (accountRef == bytes32(0)) revert ZeroValue("accountRef");
        if (agentRegistry == address(0)) revert ZeroValue("agentRegistry");
        if (agentAuthAddress == address(0)) revert ZeroValue("agentAuthAddress");
        if (policyHash == bytes32(0)) revert ZeroValue("policyHash");

        policyId = computePolicyId(msg.sender, accountRef, agentRegistry, agentRegistryId);
        if (_policies[policyId].owner != address(0)) revert PolicyExists(policyId);

        PolicyRecord storage p = _policies[policyId];
        p.owner = msg.sender;
        p.accountRef = accountRef;
        p.agentRegistry = agentRegistry;
        p.agentRegistryId = agentRegistryId;
        p.agentAuthAddress = agentAuthAddress;
        p.policyHash = policyHash;
        p.policyURI = policyURI;
        p.version = 1;
        p.delegationExpiresAt = delegationExpiresAt;

        emit PolicyCreated(policyId, msg.sender);
        emit PolicyUpdated(policyId, policyHash, 1);
        emit DelegationChanged(policyId, agentAuthAddress, delegationExpiresAt, false);
    }

    /// @notice Replace the policy document. `expectedVersion` must equal the current version (prevents races).
    function setPolicy(bytes32 policyId, bytes32 policyHash, string calldata policyURI, uint64 expectedVersion)
        external
    {
        PolicyRecord storage p = _owned(policyId);
        if (policyHash == bytes32(0)) revert ZeroValue("policyHash");
        if (p.version != expectedVersion) revert VersionMismatch(expectedVersion, p.version);
        p.policyHash = policyHash;
        p.policyURI = policyURI;
        p.version = expectedVersion + 1;
        emit PolicyUpdated(policyId, policyHash, p.version);
    }

    function setDelegation(bytes32 policyId, address agentAuthAddress, uint64 expiresAt, bool revoked) external {
        PolicyRecord storage p = _owned(policyId);
        if (agentAuthAddress == address(0)) revert ZeroValue("agentAuthAddress");
        p.agentAuthAddress = agentAuthAddress;
        p.delegationExpiresAt = expiresAt;
        p.revoked = revoked;
        emit DelegationChanged(policyId, agentAuthAddress, expiresAt, revoked);
    }

    function setPaused(bytes32 policyId, bool paused) external {
        PolicyRecord storage p = _owned(policyId);
        p.paused = paused;
        emit PausedChanged(policyId, paused);
    }

    function getPolicy(bytes32 policyId) external view returns (PolicyRecord memory) {
        PolicyRecord storage p = _policies[policyId];
        if (p.owner == address(0)) revert UnknownPolicy(policyId);
        return p;
    }

    function exists(bytes32 policyId) external view returns (bool) {
        return _policies[policyId].owner != address(0);
    }

    function _owned(bytes32 policyId) private view returns (PolicyRecord storage p) {
        p = _policies[policyId];
        if (p.owner == address(0)) revert UnknownPolicy(policyId);
        if (p.owner != msg.sender) revert NotOwner(policyId, msg.sender);
    }
}
