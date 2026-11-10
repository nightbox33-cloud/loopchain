# PoC — H-01: inyección no autenticada de mensajes xCall (suplantación de `from`)

Objetivo: `icon-project/xcall-multi` @ `d24c7b3bd12284b49b791bec6254eaf01286dbc3`
(`contracts/evm/contracts/xcall/CallService.sol`, **sin modificar**).

## Ejecución

```bash
npm i solc@0.8.26 @openzeppelin/contracts-upgradeable@5.0.2 @openzeppelin/contracts@5.0.2 \
      @ethereumjs/evm @ethereumjs/util @ethereumjs/common @ethereumjs/statemanager ethers@6
node compile.js   # compila CallService.sol del clon + helpers del PoC
node run.js       # control negativo + 3 variantes de exploit
```

`compile.js` apunta a `/home/user/audit/xcall-multi/contracts/evm` (clon del repo). Ajustar `ROOT`
si el clon está en otra ruta.

## Qué demuestra

| Escenario | Resultado |
|---|---|
| Mensaje falsificado con `protocols = []` (control) | **rechazado** (`NotAuthorized`, usa `defaultConnections`) |
| `protocols = [dirección del atacante]`, llamada directa desde una EOA a `handleMessage` | **aceptado** → `executeCall` entrega a la víctima `from = "0x2.ICON/<hub dapp>"` → **+100 ETH** |
| `protocols = [atacante, atacante]` | quórum "2-de-2" satisfecho por un solo emisor |
| `CS_RESULT` falsificado + reply (`sources=[contrato del atacante]`) | `handleResult`/`handleReply` aceptan → **+55 ETH** con `from` suplantado |

`src/PoC.sol` usa los encoders RLP del propio repositorio (`@xcall/utils/RLPEncodeStruct.sol`),
por lo que los bytes del mensaje son exactamente los que produce xCall.
`Vault` modela el patrón estándar de receptor xCall (sólo actúa si `from` es el remoto de confianza).
