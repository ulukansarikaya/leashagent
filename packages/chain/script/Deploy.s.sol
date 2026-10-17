// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PolicyRegistry} from "../contracts/PolicyRegistry.sol";
import {DecisionLog} from "../contracts/DecisionLog.sol";

/// Usage (Fuji):
///   DEPLOYER_PRIVATE_KEY=0x... LOGGER_ADDRESS=0x... \
///   forge script script/Deploy.s.sol --rpc-url fuji --broadcast
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address logger = vm.envAddress("LOGGER_ADDRESS");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);
        PolicyRegistry registry = new PolicyRegistry();
        DecisionLog log_ = new DecisionLog(deployer);
        log_.setLogger(logger, true);
        vm.stopBroadcast();

        console2.log("POLICY_REGISTRY_ADDRESS", address(registry));
        console2.log("DECISION_LOG_ADDRESS", address(log_));
    }
}
