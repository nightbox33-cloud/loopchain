# Auditoría ofensiva — `loopchain` (ICON Foundation)

**Target:** `nightbox33-cloud/loopchain` → idéntico a `icon-project/loopchain`
**Commit auditado:** `41b940e762f8abbffcfdea0da3317c64e6b78ced`
**Fecha:** 2026-11-07

---

## VEREDICTO

# NO CRÍTICO LIVE

No existe ninguna vulnerabilidad crítica que pase los 4 criterios. El hecho que lo
mata es previo a cualquier bug: **este código no corre en mainnet**. Añadido a eso,
**loopchain no custodia ni un loop de inventario ajeno**.

Se documenta abajo un bug de consenso **real y confirmado con PoC ejecutable**, con el
análisis exacto de por qué **no** califica como crítico.

---

## 1. REQUISITO PREVIO OBLIGATORIO — estado

### 1.1 Orgs/espacios de la fundación enumerados

| Org / espacio | Identidad | Repos públicos | Estado |
|---|---|---|---|
| `icon-project` | **ICON Foundation** (`icon.foundation`) | 110 | ✅ clonada completa |
| `icon-foundation` | "Icon Foundation" (org vacía/homónima) | 0 | ✅ nada que clonar |
| `iconloop` | PARAMETA CORP — org **corporativa adyacente**, no la fundación | 19 | ⚠️ clonado sólo `LFT2` (spec de consenso) |

`icon-project` es la única org de la fundación. `iconloop` se auditó parcialmente por
contener `LFT2`, la especificación del algoritmo de consenso LFT2 movida desde
`icon-project/LFT2`.

### 1.2 Repos clonados: **110 / 110 (100 %)**

```
Clonados OK : 110
Fallidos    : 0
Bloqueados  : 0   ← no hay repos privados ni inaccesibles
Git LFS     : ningún repo usa LFS
Tamaño      : 2.4 GB en /home/user/icon-repos
```

Se hizo `git fetch --all --tags --prune` en cada repo. Submódulos inicializados
recursivamente:

| Repo | Submódulos |
|---|---|
| `btp2` | 2 / 2 |
| `btp2-bsc` | 3 / 3 |
| `btp2-eth2` | 2 / 2 |
| `xcall-multi` | 6 / 6 |
| `IBC-Integration` | 1 / 1 |
| `ibc-relay` | 4 / 4 |

**Se declara cobertura completa de la fundación: cero repos bloqueados.**

El clon de `loopchain` se des-shalloweó localmente (1522 commits, vs. el `grafted`
inicial de 1 commit) para poder auditar historia completa.

### 1.3 Identidad del fork

| | |
|---|---|
| Fork HEAD | `41b940e762f8abbffcfdea0da3317c64e6b78ced` |
| Upstream HEAD | `41b940e762f8abbffcfdea0da3317c64e6b78ced` |
| Tree hash fork | `9744ebf1ccad704925e0ebfb97a753b7f8c5aa17` |
| Tree hash upstream | `9744ebf1ccad704925e0ebfb97a753b7f8c5aa17` |

**El fork no añade ni un commit.** El árbol es byte-idéntico a `icon-project/loopchain`.
Auditar el fork == auditar upstream. No hay código "inyectado" por el fork.

### 1.4 Commit hashes de los repos del stack in-scope

| Repo | Commit | Fecha |
|---|---|---|
| **`loopchain` (in-scope)** | `41b940e762f8abbffcfdea0da3317c64e6b78ced` | 2021-12-15 |
| `icon-service` | `dfa61fcc42425390a0398ada42ce2121278eec08` | 2021-12-15 |
| `icon-rpc-server` | `8f78933fcf3b4e646c5947004f312c7159087caa` | 2021-12-15 |
| `icon-commons` | `1abbeb4be71e468cd615d975cb29677304787610` | 2021-12-15 |
| `rewardcalculator` | `f955fcca184d62d20b8208459f108fef0b41404b` | 2021-07-08 |
| `governance2` | `a5905c0831e276959665ee470ed92dfdacf4c99e` | 2023-08-25 |
| **`icon2-docker` (despliegue live)** | `bb0dc8035f03fe7801be5f63517614dcccbf894f` | 2026-10-27 |
| `btp2` | `3f1e8629bc3806a9a8c3242c33164f55183d9367` | 2024-07-04 |
| `xcall-multi` | `d24c7b3bd12284b49b791bec6254eaf01286dbc3` | 2026-10-15 |
| `centralized-relay` | `ede609cc183afc79a02db2eafa74e3daebfc269a` | 2025-10-10 |
| `icon-bridge` | `2fd3ab32f8144df27ce9517460492d363e6d09b3` | 2025-02-03 |
| `preptools` | `aba67f8112ab999cffc349343dde4d5f863445b6` | 2023-11-10 |
| `IIPs` | `73907b3f9cf20b42f35dbe83fc7b035a29009b39` | 2023-11-06 |
| `loopchain` (LFT2, iconloop) | `3862d63aaf148f99240c6d4a54408dc2520b94c6` | 2020-04-09 |

---

## 2. Anclaje del estado live

### 2.1 El motor que corre ICON mainnet es goloop, no loopchain

| Evidencia | Fuente |
|---|---|
| `README.md` línea 1: *"This repository archived. Refer to ICON 2.0 aka goloop"* | clon, `41b940e` |
| Último commit: `add archive message of loopchain` | `41b940e`, 2021-12-15 |
| Repo marcado `archived` en GitHub | `gh api orgs/icon-project/repos` |
| `icon2-docker` (artefacto de despliegue del nodo, actualizado 2026-10-27) monta `/goloop`, `goloop.log`, `goloop/configure.yml` — **cero referencias a loopchain** | clon `bb0dc803` |
| Migración ICON1→ICON2 completada Nov 2021 (Stage 3: ICON1 entra en *suspend*, `goloop chain start`) | [guía oficial de migración](https://icondev.io/icon2.0-migration-guide) |

Loopchain incluye además **auto-apagado por gobernanza**, código escrito por la propia
fundación para matarse:

```python
# loopchain/blockchain/blockchain.py:1382
if response.get("is_shutdown") == "0x1":
    self._prepare_shutdown(_block.header.height + 1)   # para el chain
```

```python
# loopchain/channel/channel_service.py:316
if self.__block_manager.is_shutdown_block():
    self.__state_machine.suspend()
```

Commits históricos que lo confirman: `[IC2-185] preparing loopchain shutdown (#630)`,
`Set shutdown block height on next block of approved shutdown proposal`.
**El shutdown ya se ejecutó.** Loopchain no produce bloques desde Nov 2021.

### 2.2 Estado live de la red ICON hoy (2026-11-07)

| Hito | Fecha | Estado |
|---|---|---|
| ICON2 / goloop activado en mainnet | Nov 2021 | ✅ hace 5 años |
| **Economic shutdown** — emisión de ICX y staking rewards detenidos | 2026-03-26 | ✅ activo |
| Migración ICX↔SODA deja de ser bidireccional (sólo ICX→SODA) | 2026-09-30 | ✅ activo |
| **Halt permanente de la red** — cadena pasa a archivo read-only | 2026-12-31 | ⏳ **en 54 días** |

Fuentes: [icon.foundation blog](https://www.icon.foundation/blog/2026/final-date-set-for-sodax-migration-icon-network-to-shut-down-end-of-2026), [BigGo Finance](https://finance.biggo.com/news/NmRfYJ4BLfE1EzqPG6D8), [CryptoTimes](https://www.cryptotimes.io/2026/05/25/icon-network-to-shut-down-in-dec-2026-as-ecosystem-moves-to-soda/).

*Nota metodológica:* el sandbox tiene salida restringida a `github.com` / `npm` / `pypi`,
por lo que no pude consultar `ctz.solidwallet.io` directamente. El anclaje live se hizo
contra los clones (`icon2-docker`, configs de mainnet) más fuentes públicas. El
resultado es inequívoco y no depende de explorer ni TVL desfasado.

### 2.3 Parámetros live declarados en el propio repo (ya históricos)

`conf/mainnet/loopchain_conf.json` @ `41b940e`:

| Parámetro | Valor |
|---|---|
| `radiostations` | `https://ctz.solidwallet.io` |
| `crep_root_hash` | `0xd421ad83f81a31abd7f6813bb6a3b92fa547bdb6d5abc98d2d0852c1a97bcca5` |
| nid | `0x1` (mainnet) |
| block_versions | `0.1a`:0, `0.3`:10324749, `0.4`:12640761, `0.5`:14473622 |
| `VOTING_RATIO` | `0.67` (`configure_default.py:135`) |
| `ALLOW_MAKE_EMPTY_BLOCK` | `false` |

---

## 3. Inventario medido — ¿de dónde saldría el dinero?

**Inventario ajeno dentro de `loopchain`: 0.**

Búsqueda exhaustiva de superficie con valor en `loopchain/` (26 579 LOC Python):

| Concepto | Hallazgo |
|---|---|
| balances / cuentas | ❌ ninguno (salvo validación de shape del genesis tx, `genesis/transaction_verifier.py:33`) |
| mint / burn / supply | ❌ ninguno (sólo `converter.py` define el *template* RPC `get_total_supply`) |
| escrow / vault / bridge / collateral | ❌ ninguno |
| fee retenido | ❌ `channel_inner_service.py:833` → `full_data["fee"] = hex(step_used * step_price)` es **formateo de display** del receipt, no custodia |
| rewards / I-Score | ❌ ninguno (vive en `icon-service` y en el daemon `rewardcalculator`) |

**Loopchain es un motor de consenso + red.** No ejecuta SCOREs, no toca estado de
balances, no firma transferencias. Todo el valor del ecosistema ICON vive en el estado
de `icon-service`; en mainnet live, dentro de **goloop**.

Consecuencia directa para el criterio 4: **aunque se rompiera loopchain por completo,
no hay delta > 0 extraíble de inventario ajeno dentro de este componente.**

---

## 4. Hallazgo de código real (NO crítico live)

### 4.1 El bug

**Quórum de votos alcanzable con votos no verificados (firmas falsas).**

`loopchain/blockchain/votes/votes.py` — `Votes.verify()`:

```python
def verify(self):
    for rep, vote in zip(self.reps, self.votes):   # ← zip TRUNCA en min(len(reps), len(votes))
        if not vote:
            continue
        if rep != vote.rep:
            raise RuntimeError(...)
        try:
            self.verify_vote(vote)                 # ← aquí está la verificación ECDSA
        except VoteSafeDuplicateError:
            pass
```

`loopchain/blockchain/votes/v0_5/votes.py` — `BlockVotes.get_result()`:

```python
def get_result(self):
    true_vote_count = sum(1 for vote in self.votes          # ← itera TODA la lista
                          if vote and vote.block_hash == self.block_hash)
    if true_vote_count >= self.quorum:
        return True
```

`loopchain/blockchain/blocks/v0_4/block_verifier.py` — `verify_prev_votes()`:

```python
prev_votes = BlockVotes(prev_reps, conf.VOTING_RATIO, header.height - 1,
                        round_, header.prev_hash, body.prev_votes)   # ← lista del atacante
if prev_votes.get_result() is not True:    # decisión de quórum sobre TODA la lista
    self._handle_exception(...)
try:
    prev_votes.verify()                    # verificación sólo sobre zip(reps, votes)
except Exception as e:
    self._handle_exception(e)
```

`body.prev_votes` se deserializa directo del JSON del bloque
(`blocks/v0_5/block_serializer.py::_deserialize_body_data`) **sin chequeo de longitud**.

> **Votos en índices ≥ `len(reps)` se cuentan para el quórum pero nunca se verifican.**

Mismo patrón en `LeaderVotes` → `get_majority()` → `Counter` sobre toda la lista:
permite forjar la **elección de líder** (`verify_leader_votes()`), no sólo el quórum.

### 4.2 PoC ejecutable — `poc_vote_quorum.py`

Ejecuta contra el clon real (carga los módulos de `votes`/`v0_5`/`signature` desde el
repo, con `VOTING_RATIO` leído de `configure_default.py`). Sin mocks, sin `prank`,
sin `deal`.

```
VOTING_RATIO (from loopchain/configure_default.py) = 0.67

reps = 22   quorum = ceil(0.67*22) = 15
prevVotes list len = 37   (len(reps) = 22, overflow = 15)
  genuine votes collected : 0
  forged (garbage sig)    : 15  at indices 22..36

[1] BlockVotes.get_result()  -> True          ← quórum "alcanzado"
    verify_prev_votes() requires `get_result() is True` -> PASS
[2] BlockVotes.verify()      -> PASSED (no exception raised)   ← firmas nunca chequeadas

[3] Forged votes verified standalone (each on its own):
      forged[0].verify() -> REJECTED (RuntimeError)   ← son criptográficamente inválidos
      forged[1].verify() -> REJECTED (RuntimeError)
      forged[2].verify() -> REJECTED (RuntimeError)

[4] CONTROL — same forged votes, but placed INSIDE the zip range (no overflow):
      len(votes)=22  get_result()=True
      verify() -> RAISED RuntimeError  <-- forged sigs correctly caught

[5] LeaderVotes — forging leader election with unverified votes:
      len(self.votes)=37 (len(reps)=22)
      get_result() == attacker(hx126f3cc550f9...) -> True
      verify() -> PASSED (no exception)
      forged_leader[0].verify() -> REJECTED (RuntimeError)

VERDICT: CONFIRMED — quorum reached with forged votes; verify() still passes.
  15 forged/unsigned votes were COUNTED toward quorum;
  0 of them were signature-checked (zip() stopped at len(reps)=22).
```

El control [4] es la parte importante: los **mismos** votos falsos sí son rechazados
cuando caen dentro del rango de `zip`. Eso aísla la causa en el truncamiento de `zip`,
no en debilidad de firmas ni en el setup del PoC.

### 4.3 Los 4 criterios — evaluación

| # | Criterio | ¿Pasa? | Hecho que lo mata |
|---|---|---|---|
| 1 | Bug en código que **sí corre live** | ❌ | `loopchain` está archived y auto-apagado desde Nov 2021. Motor live = **goloop**. `icon2-docker` (despliegue live, 2026-10-27) no contiene loopchain. |
| 2 | **Permissionless** | ❌ | Para que el bloque se acepte: `verify_signature(block)` exige firma válida de `header.peer_id`, y `_verify_common` exige `header.peer_id in reps`. Requiere ser **P-Rep electo** (top-22) con su clave. Rol con credencial, no permissionless. |
| 3 | Call graph / state transition **REAL y LIVE** | ❌ | El path `verify_prev_votes` no se ejecuta en ningún validador live: no hay ningún nodo loopchain produciendo bloques. |
| 4 | PoC con PnL > 0 sobre **inventario ajeno** | ❌ | Loopchain custodia **0** inventario (§3). El bug es de *safety* de consenso, no mueve valor por sí mismo. Además el endpoint live está en economic shutdown y se apaga el 2026-12-31. |

**Conclusión:** bug de consenso real, severidad alta en abstracto, **0 crítico live**.
Si alguien lo reportara como crítico estaría inflando: el componente no está desplegado,
el rol requerido es un validador con credencial, y el proceso no toca fondos.

### 4.4 Otras superficies revisadas y descartadas

| Superficie | Veredicto |
|---|---|
| `v3_issue` tx con `_allow_unsigned = True` (`transactions/v3_issue/transaction_verifier.py`) | **`_allow_unsigned=True` es intencional**: el base/issue tx lo genera `icon-service` (`base_transaction_creator.py:34`), no el usuario. En `icon-service`, índice 0 exige `dataType=="base"` y `_invoke_base_request` compara contra `create_icx_issue_info`. Un tx de usuario con `dataType:"base"` cae en `_invoke_request` (índice ≠ 0) y pasa validación completa. **No explotable.** |
| `SignVerifier.verify_signature` / recuperación ECDSA (`crypto/signature.py`) | Estándar: `coincurve.PublicKey.from_signature_and_message` + `sha3_256(pubkey[1:])[-40:]`. Sin bypass encontrado. |
| Dominio separado de hash (`hash_generator.py`, salt `icx_sendTransaction` / `icx_vote`) | Correcto. El `verify_hash` de `v3_issue` es tautológico por construcción, pero ese serializador sólo se usa para el base tx que genera el propio iconservice. |
| `Votes.verify_vote` → `self.reps.index(vote.rep)` | Correcto **cuando** se invoca; el fallo es que no se invoca para índices ≥ `len(reps)` (§4.1). |
| `epoch.py` / `crep_root_hash` | Reps derivados del root hash on-chain; no hay path de sustitución permissionless. |
| REST / JSON-RPC (`rest_service.py`, puertos `configure_default.py`) | Superficie de consulta/relay. Sin custodia. No mueve valor. |

---

## 5. Respuesta directa a las preguntas del brief

- **¿Vulnerable ahora?** El bug del §4 existe en el código en `41b940e`, pero **no está
  desplegado**. ICON mainnet corre goloop desde Nov 2021.
- **¿Drena terceros?** No. Loopchain no custodia inventario ajeno (medido: 0).
- **Addresses / program ids / module accounts live:** ninguno pertenece a este
  componente. Inventario tocable vía loopchain = **$0**.
- **$ aproximado tocable:** **$0**.
- **El hecho que lo mata:** el repo está archived con auto-shutdown ejecutado
  (`_prepare_shutdown` vía gobernanza `is_shutdown == "0x1"`), el artefacto de
  despliegue live (`icon2-docker`) es 100 % goloop, y el proceso no custodia fondos.
- **Repos bloqueados:** **ninguno**. 110/110 clonados → cobertura completa declarable.
