# Auditoría de seguridad — ICON Foundation / stack in-scope

**Fecha:** 2026-11-10
**Repositorio de trabajo:** `nightbox33-cloud/loopchain` (rama `arena/8200bf3e-loopchain`, base `41b940e`)
**Método:** clonado estático + lectura de código + PoC local **sin RPC** (no se consultó ningún nodo).

---

## 0. Resumen ejecutivo

| ID | Severidad | Componente | Estado en `main`/HEAD |
|----|-----------|-----------|------------------------|
| **H-01** | **CRÍTICO** | `icon-project/xcall-multi` — `CallService` (EVM / javascore-ICON / CosmWasm / Sui / Solana / Soroban) | **ABIERTO** (no mitigado en código) |

**H-01:** el punto de entrada de mensajes cross-chain de xCall (`handleMessage`) es **público y se autentica contra un array `protocols` que viaja dentro del propio mensaje**. Un atacante sin ningún rol (basta una EOA) se declara a sí mismo como "conexión" y entrega a *cualquier* contrato de la cadena un mensaje cross-chain fabricado, con el campo `from` ("`nid/dirección`") **elegido libremente**. Se rompe así la propiedad de seguridad central de xCall (autenticidad del remitente remoto), que es exactamente lo que asumen los dapps integrados (vaults, puentes, *asset managers*, préstamos). Sin relayer, sin contrato de conexión, sin fee y sin bond.

PoC local ejecutado contra el `CallService.sol` **sin modificar** del commit auditado: la EOA atacante extrae **100 ETH** de un vault que custodia fondos de terceros y **55 ETH** en la variante "reply". Ver §4.

**Nota sobre el repo de trabajo (`loopchain`):** auditado a fondo; **no se encontró vulnerabilidad crítica explotable**. Además el motor Loopchain 2.8.1 está archivado desde 2021 e ICON 2.0 corre `goloop`, por lo que ese código no es el motor de consenso en producción hoy. Detalle e invariantes verificados en §5.

**Cobertura:** no se declara cobertura completa. Los contratos de producción del hub SODAX (*Asset Manager* / contrato de migración) **no son públicos** (ver §3.3.bis); el exploit del 27-ago-2026 descrito en el post-mortem de la fundación vive en ese código cerrado y queda **fuera del alcance material** de esta auditoría.

---

## 1. Requisito previo: enumeración de la fundación y clonado

### 1.1 Organizaciones / espacios enumerados

| Espacio | Uso | Acceso |
|---|---|---|
| `github.com/icon-project` (≈140 repos) | org principal: nodo (`goloop`), contratos xCall, relay, BTP, SDKs, documentación | público |
| `github.com/gosodax` (5 repos) | SDKs y plantillas SODAX (TypeScript) | público; **sin contratos** |
| `github.com/icon-project/sodax-document`, `sodax-scan`, `sodax-backend-analyzer` | documentación / explorador / analítica SODAX | público |
| docs: `icon.foundation`, `sodax.*`, `xcall.dev` | parámetros y direcciones de despliegue | público |
| Contratos del hub SODAX (*Asset Manager*, *migration contract*) | custodia de valor del puente | **NO PÚBLICO → BLOQUEADO** |

### 1.2 Repositorios clonados (commit exacto)

| Repo | Commit | Fecha | Notas |
|---|---|---|---|
| `icon-project/loopchain` (este repo) | `41b940e762f8abbffcfdea0da3317c64e6b78ced` | 2021-12-15 | `VERSION=2.8.1`, archivado |
| `icon-project/xcall-multi` | `d24c7b3bd12284b49b791bec6254eaf01286dbc3` | 2026-10-15 | `main`; incluye PR #439 (fix reply-spoofing, parcial) |
| `icon-project/centralized-relay` | `ede609cc183afc79a02db2eafa74e3daebfc269a` | 2025-10-10 | relayer Go multi-chain |
| `icon-project/governance` | `fa1703c897c3aef7c8e8d73d6326c68f274a01cf` | 2022-02-09 | SCORE de gobernanza ICON 1.0, archivado (sustituido por `governance2`) |

Clonado con `git clone --depth 1` (más `git fetch` de `main` en `xcall-multi` para obtener historial de los PR de fix). Submodules: `xcall-multi/contracts/evm/lib/*` están **vacíos** en el clon (requieren `forge install`); el PoC resuelve las dependencias de OpenZeppelin vía `registry.npmjs.org`, no vía git.

### 1.3 Ficheros de despliegue/configuración inspeccionados

- `loopchain/conf/mainnet/loopchain_conf.json`, `loopchain/conf/mainnet/{iconservice,iconrpcserver}_conf.json`
- `loopchain/citizen/conf/citizen_mainnet.json`, `citizen/conf/iconservice_mainnet.json`
- `loopchain/loopchain/configure_default.py` (versiones de bloque por altura: `0.3@10324749`, `0.4@12640761`, `0.5@14473622`; `crep_root_hash`)
- `xcall-multi/contracts/evm/foundry.toml`, `remappings.txt`, `deploy_script.sh`, `script/CallService.s.sol`
- `xcall-multi/docs/centralized-connection*.md`, `docs/adr/*`
- `centralized-relay/deployment/ansible/**`, `relayer/chains/{icon,evm,sui,solana}/**` (mapa de contratos `XcallContract` / `ConnectionContract`)

---

## 2. Arquitectura in-scope (mapa leído del código)

```
                      ┌─────────────── EVM / CosmWasm / Sui / Solana (spokes) ───────────────┐
  dapp  ──sendCallMessage──►  xCall CallService  ──sendMessage──►  Connection (Centralized |
                                                                   Cluster/BTP | LayerZero | Wormhole)
                                                                          │  (relayer / VAA / packet)
                      └───────────────────────────────────────────────────┼──────────────────┘
                                                                          ▼
  dapp  ◄──handleCallMessage──  xCall CallService (hub ICON, cx…)  ◄──handleMessage── Connection
                                     │
                                     └─ proxyReqsV2[reqId] ──(executeCall, permissionless)──► dapp
```

Puntos de entrada permissionless relevantes:
- `CallService.handleMessage(nid, bytes)` — **público/@External**, sin control de acceso.
- `CallService.executeCall(reqId, data)` — público/@External, cualquiera puede ejecutar una petición encolada.
- `CallService.sendCall / sendCallMessage` — público, origina mensajes.

---

## 3. H-01 — Inyección no autenticada de mensajes xCall y suplantación de `from` (CRÍTICO)

### 3.1 Ubicación exacta

**Repo `icon-project/xcall-multi`, commit `d24c7b3bd12284b49b791bec6254eaf01286dbc3` (main).**

**(a) EVM — `contracts/evm/contracts/xcall/CallService.sol`**

| Elemento | Líneas | Qué hace |
|---|---|---|
| `handleMessage(string _from, bytes _msg)` | **401-419** | `public`, único check: `require(!_from.compareTo(nid))`. Enruta a `handleRequest` / `handleResult`. |
| `handleRequest(netFrom, payload)` | **441-481** | Autenticación del emisor (ver abajo). |
| ↳ rama multiprotocolo | **451-460** | `pendingReqs[dataHash][msg.sender.toString()] = true;` y luego exige que **todas** las entradas de `req.protocols[]` estén marcadas. |
| ↳ rama 1 protocolo | **461-465** | `require(msg.sender == req.protocols[0].parseAddress(...), "NotAuthorized");` |
| ↳ rama 0 protocolos (única correcta) | **466-468** | `require(msg.sender == defaultConnections[fromNID], "NotAuthorized");` |
| `proxyReqsV2[reqId] = …` | **471-478** | Guarda `from` (string libre), `to`, `sn`, `type`, `hash(data)`, `protocols`. |
| `executeCall(reqId, _data)` | **279-320** | Público; sin comprobar quién ejecuta. |
| `executeMessage(to, from, data, protocols)` | **347-359** | `IDefaultCallServiceReceiver/ICallServiceReceiver(to).handleCallMessage(from, data[, protocols])` → **la víctima recibe `from` del atacante**. |
| `handleReply(rollback, reply)` | **483-500** | Sólo valida `rollback.to == reply.from.nid()`. **No** valida `reply.to == rollback.from`. |
| `handleResult(res)` | **502-528** | Autentica el resultado contra `rollback.sources` (configurado por el **originador local**, ver variante 3). |

**(b) ICON / javascore — `contracts/javascore/xcall/src/main/java/foundation/icon/xcall/CallServiceImpl.java`**

| Elemento | Líneas | Qué hace |
|---|---|---|
| `handleMessage(String _fromNid, byte[] _msg)` | **224-239** | `@External`, sin control de acceso |
| `handleRequest(netFrom, data)` | **456-474** (preProcessMessage origen: 404-416) | decodifica `from`/`to`/`protocols` del payload y llama a `verifyProtocols` |
| `verifyProtocols(...)` | **518-542** | `protocols.length == 1` → `Context.require(caller.toString().equals(protocols[0]), "ProtocolSourceMismatch")` (**L523-525**) |
| `executeCall(reqId, data)` | **178-188** | público |
| `executeMessage(reqId, req, data)` | **418-447** | `Context.call(dapp, "handleCallMessage", req.getFrom(), data)` |
| `handleReply(rollback, reply)` | **476-484** | sólo `rollback.to == reply.from.nid()` |

**(c) CosmWasm — `contracts/cosmwasm-vm/cw-xcall/src/handle_call_message.rs` + `src/contract.rs`**

- `contract.rs:98` `ExecuteMsg::HandleMessage { msg, from_nid }` → despachado **sin comprobar `info.sender`**.
- `handle_call_message.rs:216-232` `is_valid_source()`: `if protocols.contains(source) { return Ok(true) }` — misma autenticación circular.
- `handle_call_message.rs:30-38` `handle_reply()`: comentario del propio equipo — *"// reply can be targeted to source nid but any contract"*.

### 3.2 Explicación del bug

La única autenticación del emisor de un mensaje entrante se realiza **contra datos contenidos en el propio mensaje no autenticado**:

```solidity
// CallService.sol:461-468
} else if (req.protocols.length == 1) {
    require(msg.sender == req.protocols[0].parseAddress("IllegalArgument"), "NotAuthorized");
} else {
    require(msg.sender == defaultConnections[fromNID], "NotAuthorized");   // ← única rama segura
}
```

`req.protocols` se rellena en el origen con `envelope.destinations`, un array **arbitrario elegido por el dapp que envía** (`_sendCallMessage(..., destinations)` → `CSMessageRequestV2(..., envelope.destinations)`). En recepción no existe ningún registro local que valide que esas direcciones sean conexiones aprobadas: no hay allowlist, no hay `isConnection[...]`, y `defaultConnections` **sólo se usa si `protocols` está vacío**.

Consecuencias directas:

1. **Rama 1 protocolo:** el atacante pone su propia dirección en `protocols[0]` y llama él mismo a `handleMessage` → `msg.sender == protocols[0]` se cumple trivialmente. **No hace falta ser una conexión, ni un relayer, ni un contrato: una EOA basta.**
2. **Rama multiprotocolo (>1):** el "quórum N-de-N" se satisface con **una sola entrega** si el array repite la misma dirección (`["0xATACANTE","0xATACANTE"]`), porque el bucle compara los slots de `req.protocols[]` contra un mapa indexado por `msg.sender`. El quórum se colapsa a 1-de-N.
3. **Campo `from` totalmente suplantable:** `req.from` es un string libre; la única comprobación es `netFrom == req.from.nid()` (`L448`), es decir, coherencia interna entre dos valores que el atacante elige. La víctima recibe `handleCallMessage(from = "nid/dirección remota", data = …)` con la dirección que el atacante quiera (p. ej. el dapp legítimo del hub).
4. **Ejecución permissionless:** `executeCall` es público y sólo exige que `keccak256(_data)` coincida con el hash guardado — el atacante conoce `_data` porque lo fabricó.

**Variante 3 ("reply spoofing").** Además del camino de *request*, el atacante puede fabricar el camino de *result/reply* sin ningún puente real:

- `sendCallMessage(to, data, rollback, sources=[dirección del atacante], destinations=[])` es público; `sources` es elegido por el llamante. xCall invocará `IConnection(sources[0]).sendMessage(...)` sobre **un contrato del atacante** (no-op) y almacenará `rollbacks[sn] = {from: atacante, to: nid destino, sources: [atacante], rollback, enabled:false}` (`preProcessMessage`, L209-235).
- Después, el atacante llama `handleMessage(destNid, CSMessage(CS_RESULT, CSMessageResult(sn, SUCCESS, <reply>)))`. `handleResult` acepta porque `rollback.sources.length == 1 && msg.sender == rollback.sources[0]` (L517-522).
- `handleReply` (L483-500) sólo comprueba que el `from` del reply pertenezca al **nid** de destino; **nunca** que `reply.to == rollback.from` (el contrato que originó la petición) ni que el `sn` corresponda. El "reply" se entrega a **cualquier** dirección de la cadena, con `from` = `"<nid destino>/<dirección inventada>"`.

Esto es exactamente la primitiva que el PR **#439** ("fix(icon): disable rollback origination…", fusionado 2026-10-15) describe como *"rollback state that a forged result/reply was then matched against"*: ese PR sólo **elimina la originación de rollbacks en ICON** (rama `preProcessMessage`/`sendCallMessage`), lo que mata el camino de *result/reply* en ICON pero **deja intacto el camino de *request*** (§3.2.1-4), que es el más potente. El PR **#440** (`feat/xcall-receive-switch`, **aún abierto**, no fusionado) añade un interruptor admin por red de origen (`receiveEnabled[nid]`), que **no valida al emisor**: el atacante simplemente usa un `nid` habilitado. En **EVM y CosmWasm no hay ni siquiera esos parches**: el PR de arreglo EVM mencionado en #439 (`fix/xcall-evm-reply-validation`) **no existe** en el repositorio (verificado por API de PRs/ramas).

### 3.3 Condiciones de configuración (leídas del repo)

- **Ninguna condición especial.** No requiere `RECOVERY_MODE`, ni parámetros admin, ni una conexión mal configurada.
- La única rama segura es `protocols == []` (`defaultConnections[fromNID]`, fijada por `setDefaultConnection`, L581). El flujo legítimo de 3 argumentos (`sendCallMessage(to,data,rollback)`) genera `protocols = []`; el fallo es que **el receptor acepta ramas `protocols != []` que ningún emisor legítimo necesita**.
- `MAX_DATA_SIZE = 2048` (L37) no limita nada relevante.
- Deployments: `contracts/evm/script/CallService.s.sol` + `deploy_script.sh` (proxy `Initializable`); javascore se despliega como SCORE en ICON (hub, `cx…`). No hay `pause`, `allowlist` ni `receiveEnabled` en ninguna de las tres implementaciones en HEAD (verificado con `grep`).
- **Dato externo no presente en el repo (TVL):** conforme a la regla de oro, no se descarta por no poder leer saldos sin RPC. El bug es explotable contra **cualquier** contrato xCall-integrado que custodie valor; el post-mortem de la fundación (27-ago-2026) documenta que el *Asset Manager* libera retiros contra mensajes que pasan por xCall, es decir, exactamente el patrón vulnerable.

### 3.4 PoC local ejecutado (sin RPC, sin fork)

Artefactos en `./audit/xcall-message-injection/`:

- `src/PoC.sol` — `ForgeHelper` (construye los bytes RLP con los **encoders del propio repo**, `RLPEncodeStruct`), `AttackerConn` (conexión no-op controlada por el atacante) y `Vault` (dapp víctima que modela el patrón estándar: sólo libera fondos si xCall le dice que el mensaje viene de `0x2.ICON/hx2222…`).
- `compile.js` — compila **`contracts/xcall/CallService.sol` sin modificar** del clon + el PoC (solc-js 0.8.26).
- `run.js` — despliega y ejecuta en una EVM local (`@ethereumjs/evm` 10.1.3).

Comandos:

```bash
cd audit/xcall-message-injection
npm i solc@0.8.26 @openzeppelin/contracts-upgradeable@5.0.2 @openzeppelin/contracts@5.0.2 \
      @ethereumjs/evm @ethereumjs/util @ethereumjs/common @ethereumjs/statemanager ethers@6
node compile.js     # compiled: CallService:23458B ForgeHelper:4642B Vault:2632B AttackerConn:907B
node run.js
```

Salida (íntegra en `poc-output.txt`):

```
[setup] CallService deployed at 0x8f7a45ebde059392e46a46dcc14ab24681a961ea nid = 0x1.ETH
[setup] Vault deployed at 0x39c2540cc64c8562269200ee459dc2853aab9d87 balance = 100n ETH
[setup] Vault only releases funds when xCall reports from = 0x2.ICON/hx2222222222222222222222222222222222222222

[control] forged message with protocols = [] (must be rejected)
  rejected as expected -> 0x08c379a0…            # NotAuthorized (defaultConnections)

[exploit] attacker EOA calls handleMessage() directly, listing its own
          address in the message-supplied `protocols` array
  handleMessage accepted (no relayer, no connection contract, no fee)
  executeCall(1) -> Vault.handleCallMessage(from ="0x2.ICON/hx2222…", data = ...)
  attacker balance delta = 100n ETH
  vault balance now      = 0n ETH

[exploit 2] same forgery with protocols = [attacker, attacker]
             (the "multi-protocol quorum" branch, lines 451-460)
  quorum satisfied by a single caller; 2-of-2 quorum collapsed to 1-of-2

[exploit 3] forged CS_RESULT + reply (the "reply spoofing" leg)
  attacker-controlled "connection": 0xA1eD4d0134858BAe8B320F13C90ab97Fb8222677
  rollback state created for sn=1 (from attacker, sources=[attackerConn])
  forged CS_RESULT accepted: handleResult -> handleReply (rollback.sources check passes)
  vault2 called with from ="0x2.ICON/hx2222…" although no such reply ever existed
  attacker balance delta = 55n ETH

RESULT: attacker EOA took 100 ETH of third-party funds from the Vault
        with a forged cross-chain message from a non-existent relayer.
```

**PnL del atacante:** input X = gas de 2 transacciones propias (≈ 150k + 120k gas; **cero** capital, cero fee de protocolo, cero bond, cero rol). Output Y = 100 ETH de fondos de terceros (+55 ETH en la variante reply). No hay flash loan ni préstamo que devolver: `Y > X`, y se mantiene tras cerrar cualquier operación.

**Control negativo incluido:** el mismo mensaje con `protocols = []` es rechazado (`NotAuthorized`), lo que demuestra que el bypass es exactamente la rama `protocols != []` y no un artefacto del arnés.

### 3.5 Cumplimiento de los 4 criterios

1. **Bug concreto en código de producción:** sí — auth basada en datos del propio mensaje (callbacks/autenticación), en `main` de `xcall-multi`, con parches parciales (#439) y un PR de arreglo EVM inexistente.
2. **Permissionless:** sí — EOA, 2 transacciones, sin relayer ni conexión; el relayer es irrelevante (no se usa).
3. **Call graph y configuración real:** sí — `handleMessage` es `public`/`@External`, `executeCall` es público, y las ramas afectadas no dependen de configuración (sólo la rama `[]` usa `defaultConnections`).
4. **PoC local con números reales:** sí — ejecutado sobre el `CallService.sol` del clon, saldo 100 ETH → 0, atacante +100 ETH; variante reply +55 ETH.

### 3.6 Impacto

Compromiso total de la capa de mensajería: cualquier contrato que confíe en `from` de xCall (puentes, vaults, *asset managers*, colaterales, oráculos push) puede ser inducido a mover, liberar o acreditar fondos de terceros con un mensaje fabricado. No es DoS ni *self-grief*: es transferencia de valor ajeno al atacante.

### 3.7 Remediación propuesta

1. Registrar en almacenamiento las conexiones aprobadas por `nid` (allowlist) al desplegar y **exigir `msg.sender ∈ allowlist` antes de mirar `protocols`**; ignorar el array `protocols` del mensaje o validar cada entrada contra el registro local (nunca contra sí mismo).
2. En la rama multiprotocolo, exigir que los respondedores sean **direcciones distintas y registradas** (`mapping(address => bool)` con conteo), no strings del mensaje.
3. `handleReply`: exigir `reply.to == rollback.from` y `reply.sn == rollback.sn`, y que `reply.messageType` no pueda introducir estado nuevo.
4. Considerar restringir `executeCall` a un `onlySelf`/`onlyInternal` o a un ejecutor registrado (hoy cualquiera puede ejecutar peticiones encoladas).
5. Desplegar el PR #440 sólo como contención **después** de (1): el interruptor por `nid` no autentica al emisor.

---

## 4. `loopchain` (repo de trabajo): SIN vulnerabilidad crítica en código

Conclusión: **no crítico en código** (además, el motor está archivado desde 2021; ICON 2.0 usa `goloop`, por lo que no es el binario de consenso en producción — el criterio "código de producción/release" no se satisface ).

### 4.1 Invariantes y rutas críticas verificadas

| # | Invariante | Código | Verificación |
|---|---|---|---|
| 1 | Un tx firmado no puede alterarse (valor/destino/datos) sin invalidar la firma | `transactions/v3/transaction_serializer.py:from_`, `transaction_verifier.py:verify_hash/verify_signature` | PoC [2]: cambiar `value` manteniendo la firma → `TransactionInvalidSignatureError` |
| 2 | La firma debe recuperar exactamente `from` | `crypto/signature.py:SignVerifier.verify_hash` | PoC [3]: firma de otra clave → `TransactionInvalidSignatureError` |
| 3 | Un tx no puede replicarse en otra red (NID) | `v3/transaction_verifier.py:pre_verify` | PoC [4]: `TransactionInvalidNidError` |
| 4 | Un tx no puede entrar dos veces (ni en cola ni en cadena) | `channel_inner_service.py:__add_tx_list`, `verify_tx_hash_unique`, `blocks/block_verifier.py:76-93` | lectura: se re-verifica el bloque completo, incluidos hashes duplicados |
| 5 | El bloque se re-deriva por completo (txRoot, repsHash, prevVotesHash, hash, stateRoot vía re-ejecución) antes de aceptarse | `blocks/v0_3..v0_5/block_verifier.py` | lectura `_verify_common` + `verify_invoke` (compara `state_hash` re-ejecutando) |
| 6 | El líder debe pertenecer a los reps y coincidir con votos/`next_leader` | `v0_3/block_verifier.py:33-58,154-160`, `v0_5/block_verifier.py:31-100` | lectura |
| 7 | El dominio firmado de un voto incluye `rep`, `timestamp`, `blockHeight`, `round`, `blockHash` | `votes/v0_5/vote.py:to_origin_data` | PoC [5] imprime los campos; [6] reubicar un voto en otro bloque → `Vote block_hash not match` |
| 8 | Voto duplicado / sin derecho a voto se detecta | `votes/votes.py:verify_vote` | lectura (`VoteDuplicateError`, `VoteNoRightRep`) |
| 9 | La sincronización de bloques (`verify_loosely`) no relaja firma/hash: sólo omite NID, cota temporal y unicidad, y valida los votos con `votes.verify()` | `peer/block_sync.py:589-622` | lectura |
| 10 | El bloque "no confirmado" no se acepta sin confirm-info válida, y el nodo no vota un bloque inválido (`_vote` re-verifica todo) | `peer/block_manager.py:650-745` | lectura |

PoC ejecutado (`audit/poc_loopchain.py`, sin RPC):

```
[1] valid v3 tx  hash=48ce538225829d0b
    hash+signature OK (serializer-derived origin data, ecrecover vs from_address)
[2] tampered value w/ original signature -> TransactionInvalidSignatureError (rejected)
[3] foreign key's signature -> TransactionInvalidSignatureError (rejected)
[4] nid mismatch -> TransactionInvalidNidError (rejected)
[5] block vote signature OK; signed fields: ['blockHash', 'blockHeight', 'rep', 'round', 'timestamp']
[6] vote replay onto different block hash -> Vote block_hash not match (rejected)
```
(Requiere `pip install coincurve asn1crypto eth-keyfile grpcio grpcio-tools verboselogs` y el shim de paquetes descrito en §7.2.)

### 4.2 Observaciones no críticas (hardening)

- `v3_issue` (`_allow_unsigned = True`, `signer_address` → `NotImplementedError`) acepta tx **sin firma**. En este repo la construcción viene del lado `iconservice`; si el RPC/relay permitiese a un cliente externo inyectar un JSON con `version=0x3, dataType=base`, la tx se propagaría sin firma. La contabilidad de valor (y por tanto cualquier robo) vive en `iconservice`, **fuera de este repo y no auditado**; no se reporta como crítico.
- `TransactionVerifier.verify` de v3 no comprueba `MalformedStr` en `from/to/value/nonce` (v2 sí lo hace). Hoy el `from_` del serializer lanza antes, por lo que no es alcanzable.
- `verify_leader_votes` (v0_5) usa `leader_votes.round` en el mensaje de error de `block_height` (mensaje confuso), sin impacto.
- `vote_unconfirmed_block` (channel_inner_service) añade votos a `candidate_blocks` sin verificar la firma en ese punto; la verificación ocurre al construir/validar el bloque confirmado (`votes.verify()`), por lo que a lo sumo permite influir en la contabilidad interna del líder (liveness), no en la validez del bloque.

### 4.3 Falsos positivos descartados explícitamente

- **Maleabilidad ECDSA** en `SignVerifier` (no se exige `s` bajo `n/2`): no permite forjar ni cambiar el firmante; descartado (dust/grief, sin valor).
- **`cache_result` duplica excepciones** con `raise_exceptions=False`: sólo afecta al log; descartado.
- **`__add_tx_list`/`AgingCache`** sin límite estricto de tamaño: DoS temporal, sin impacto en fondos; descartado por criterio de impacto.
- **`_vote`/`verify_confirm_info`**: un peer anónimo puede enviar `AnnounceUnconfirmedBlock`; el nodo no vota bloques inválidos y la confirmación exige `votes.verify()` de los reps; descartado como robo.
- **`loopchain` requiere rol de validador** para producir bloques: cualquier ataque de consenso exige ≥ quorum de reps (rol privilegiado), lo que incumple el criterio 2.

---

## 5. Repos bloqueados / no cubiertos

| Componente | Estado | Motivo |
|---|---|---|
| Contratos del hub SODAX: *Asset Manager*, *migration contract*, *rate limiter* (víctimas y orquestadores del incidente 27-ago-2026) | **BLOQUEADO** | no existen en `icon-project` ni en `gosodax` públicos; el post-mortem confirma que el contrato afectado no está en el alcance de las auditorías publicadas |
| `icon-project/goloop` (motor de consenso **en producción** de ICON 2.0) | no auditado en esta pasada | fuera del repo solicitado; sustituye a `loopchain` como cliente de nodo |
| `icon-project/iconservice` (contabilidad de ICX/step, issue, treasury) | clonado no realizado a fondo | archivado; es donde vive la contabilidad de valor del ICON 1.0 |
| `xcall-multi/contracts/{sui,solana,soroban}` | lectura parcial | mismo patrón de autenticación que EVM/CW (a confirmar en detalle); sin toolchain local para PoC |
| `contracts/evm/lib/*` (submodules) | vacíos en el clon | requieren `forge install` (no se pudo usar `forge` en el sandbox: sin binario descargable) |

**No se declara cobertura completa** del stack: falta el código cerrado del hub, `goloop` y `iconservice`.

---

## 6. Registro de auditoría

### 6.1 Repos clonados y commits

```
loopchain          41b940e762f8abbffcfdea0da3317c64e6b78ced  2021-12-15  (VERSION 2.8.1, archived)
xcall-multi        d24c7b3bd12284b49b791bec6254eaf01286dbc3  2026-10-15  (main; PR#439 merged, PR#440 open)
centralized-relay  ede609cc183afc79a02db2eafa74e3daebfc269a  2025-10-10
governance         fa1703c897c3aef7c8e8d73d6326c68f274a01cf  2022-02-09  (archived)
```

### 6.2 Ficheros clave revisados (×)

`loopchain`: `blockchain/transactions/{transaction,transaction_builder,transaction_serializer,transaction_verifier,transaction_versioner}.py`, `transactions/{v2,v3,v3_issue,genesis}/*`, `blockchain/blocks/block_verifier.py`, `blocks/v0_{1a,3,4,5}/*`, `blockchain/votes/{vote,votes,v0_1a,v0_5}/*`, `blockchain/{blockchain,epoch,exception,types}.py`, `channel/channel_inner_service.py`, `peer/{block_manager,block_sync,consensus_siever,peer_outer_service}.py`, `baseservice/{node_subscriber,broadcast_scheduler}.py`, `crypto/{signature,hashing/*}.py`, `conf/mainnet/*`, `citizen/conf/*`, `configure_default.py`.

`xcall-multi`: `contracts/evm/contracts/xcall/{CallService,CallServiceV1}.sol`, `contracts/evm/contracts/adapters/{CentralizedConnection,ClusterConnection,LayerZeroAdapter,WormholeAdapter}.sol`, `contracts/evm/library/{utils,xcall}/*`, `contracts/evm/test/xcall/*.t.sol`, `contracts/javascore/xcall/**`, `contracts/cosmwasm-vm/cw-xcall/**`, `contracts/cosmwasm-vm/cw-{centralized,cluster}-connection/**`, `docs/*`, `foundry.toml`, `remappings.txt`.

`centralized-relay`: `relayer/chains/{icon,evm}/{client,provider,query}.go`, `deployment/**`.

### 6.3 Comandos y salidas

```text
$ cd audit/xcall-message-injection && node compile.js
compiled: CallService:23458B ForgeHelper:4642B Vault:2632B AttackerConn:907B

$ node run.js            # salida completa en poc-output.txt  (ver §3.4)

$ python3 audit/poc_loopchain.py    # salida completa en audit/poc_loopchain.out  (ver §4.1)

$ git -C xcall-multi log -1 --format='%H %ad'   → d24c7b3bd12284b49b791bec6254eaf01286dbc3 2026-10-15
$ gh api repos/icon-project/xcall-multi/pulls/439 → "fix(icon): disable rollback origination and clear forged request"
$ gh api repos/icon-project/xcall-multi/pulls?state=all → #440 abierto ("per-chain inbound receive switch");
      no existe PR/rama "fix/xcall-evm-reply-validation" (referenciado en #439)
$ grep -rn "pause|allowlist|receiveEnabled" xcall-multi/contracts/{evm,javascore,cosmwasm-vm} → sin resultados en HEAD
```

### 6.4 Limitaciones

- Sin RPC, por diseño: no se leyeron saldos/TVL ni el estado en vivo de los contratos desplegados (`xcallM` en EVM, SCORE xCall en ICON), ni si el hub está pausado tras el incidente de agosto.
- Sin `forge`/`cargo`/JVM en el entorno: el PoC se ejecuta sobre el contrato EVM compilado con `solc-js` en una EVM local; para ICON (javascore) y CosmWasm la equivalencia es por lectura de código (misma lógica, líneas citadas), no por ejecución.
- `lib/` (submodules de `xcall-multi`) vacío; OpenZeppelin se resolvió desde npm (misma versión mayor, 5.0.2).
