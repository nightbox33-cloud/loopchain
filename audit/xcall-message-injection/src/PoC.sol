// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.20;

import "@xcall/utils/RLPEncodeStruct.sol";
import "@xcall/utils/Types.sol";
import "@iconfoundation/xcall-solidity-library/interfaces/ICallServiceReceiver.sol";
import "@iconfoundation/xcall-solidity-library/interfaces/IDefaultCallServiceReceiver.sol";
import "@iconfoundation/xcall-solidity-library/utils/ParseAddress.sol";

/// Builds CSMessage bytes with the repository's own RLP encoder (no re-implementation)
contract ForgeHelper {
    using RLPEncodeStruct for Types.CSMessage;
    using RLPEncodeStruct for Types.CSMessageRequestV2;
    using RLPEncodeStruct for Types.CSMessageResult;

    function buildRequest(
        string memory from,
        string memory to,
        uint256 sn,
        int msgType,
        bytes memory data,
        string[] memory protocols
    ) external pure returns (bytes memory) {
        Types.CSMessageRequestV2 memory req =
            Types.CSMessageRequestV2(from, to, sn, msgType, data, protocols);
        return Types.CSMessage(Types.CS_REQUEST, req.encodeCSMessageRequestV2()).encodeCSMessage();
    }

    function buildRequestPayload(
        string memory from,
        string memory to,
        uint256 sn,
        int msgType,
        bytes memory data,
        string[] memory protocols
    ) external pure returns (bytes memory) {
        Types.CSMessageRequestV2 memory req =
            Types.CSMessageRequestV2(from, to, sn, msgType, data, protocols);
        return req.encodeCSMessageRequestV2();
    }

    function buildResult(uint256 sn, int code, bytes memory message) external pure returns (bytes memory) {
        Types.CSMessageResult memory res = Types.CSMessageResult(sn, code, message);
        return Types.CSMessage(Types.CS_RESULT, res.encodeCSMessageResult()).encodeCSMessage();
    }

    function addrToString(address a) external pure returns (string memory) {
        return ParseAddress.toString(a);
    }
}

/// A caller-controlled "connection": lets the attacker originate a rollback message
/// (and therefore create local rollback state) without any real relayer/connection.
contract AttackerConn {
    function sendMessage(string calldata, string calldata, int256, bytes calldata) external payable {}
    function getFee(string calldata, bool) external pure returns (uint256) { return 0; }
    function call(address target, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: msg.value}(data);
        require(ok, "call failed");
        return ret;
    }
}

/// Victim dapp: a standard xCall receiver that custodies third-party funds and only
/// releases them when xCall reports a message from the trusted remote contract.
contract Vault is ICallServiceReceiver, IDefaultCallServiceReceiver {
    address public immutable xcall;
    string public trustedRemote;

    event Released(address to, uint256 amount, string from);

    constructor(address _xcall, string memory _trustedRemote) {
        xcall = _xcall;
        trustedRemote = _trustedRemote;
    }

    receive() external payable {}

    function handleCallMessage(string memory _from, bytes memory _data, string[] memory) external {
        _handle(_from, _data);
    }

    function handleCallMessage(string memory _from, bytes memory _data) external {
        _handle(_from, _data);
    }

    function _handle(string memory _from, bytes memory _data) internal {
        require(msg.sender == xcall, "Vault: only xcall");
        require(
            keccak256(bytes(_from)) == keccak256(bytes(trustedRemote)),
            "Vault: untrusted remote sender"
        );
        (address to, uint256 amount) = abi.decode(_data, (address, uint256));
        require(address(this).balance >= amount, "Vault: insufficient balance");
        emit Released(to, amount, _from);
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "Vault: transfer failed");
    }
}
