// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal stand-in for the ERC-8004 Identity Registry (ERC-721 + tokenURI) used in local tests.
///         The real registry ABI/address on Fuji is UNVERIFIED (SONPLAN.md §24.2); only the subset Bekçi
///         relies on is modelled: register, ownerOf, tokenURI, setAgentURI, Registered event.
contract MockIdentityRegistry {
    event Registered(uint256 indexed agentId, string tokenURI, address indexed owner);
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    error NotOwner();
    error NonexistentToken(uint256 agentId);

    uint256 private _next = 1;
    mapping(uint256 => address) private _owners;
    mapping(uint256 => string) private _uris;

    function register(string calldata uri) external returns (uint256 agentId) {
        agentId = _next++;
        _owners[agentId] = msg.sender;
        _uris[agentId] = uri;
        emit Transfer(address(0), msg.sender, agentId);
        emit Registered(agentId, uri, msg.sender);
    }

    function setAgentURI(uint256 agentId, string calldata uri) external {
        if (_owners[agentId] != msg.sender) revert NotOwner();
        _uris[agentId] = uri;
    }

    function ownerOf(uint256 agentId) external view returns (address o) {
        o = _owners[agentId];
        if (o == address(0)) revert NonexistentToken(agentId);
    }

    function tokenURI(uint256 agentId) external view returns (string memory) {
        if (_owners[agentId] == address(0)) revert NonexistentToken(agentId);
        return _uris[agentId];
    }
}
