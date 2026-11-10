"""loopchain tx/vote verification invariants (local, no RPC)."""
import sys
sys.path.insert(0, '/home/user/audit/shim')

from loopchain.blockchain.transactions.v3 import TransactionBuilder, TransactionVerifier, TransactionSerializer
from loopchain.blockchain.transactions import TransactionVersioner
from loopchain.blockchain.exception import TransactionInvalidHashError, TransactionInvalidSignatureError
from loopchain.blockchain.types import ExternalAddress, Hash32
from loopchain.crypto.signature import Signer, SignVerifier
from loopchain.blockchain.votes.v0_5 import BlockVote, BlockVotes, LeaderVote

versioner = TransactionVersioner()
tv = TransactionVerifier(versioner.get_hash_generator_version("0x3"))
ts = TransactionSerializer(versioner.get_hash_generator_version("0x3"))
signer = Signer.from_prikey(bytes.fromhex("11" * 32))

from loopchain.blockchain.types import ExternalAddress

def build(**over):
    b = TransactionBuilder.new("0x3", "call", versioner)
    b.signer = signer
    b.to_address = ExternalAddress.fromhex_address("hx" + "22" * 20)
    b.value = 10 ** 18
    b.step_limit = 100000
    b.nonce = 1
    b.nid = 0x1
    b.fixed_timestamp = 1_600_000_000_000_000
    b.data_type = "call"
    b.data = {"method": "transfer", "params": {"to": "hx" + "33" * 20, "value": "0x10"}}
    for k, v in over.items():
        setattr(b, k, v)
    return b.build()

tx = build()
print("[1] valid v3 tx  hash=%s" % tx.hash.hex()[:16])
tv.verify_hash(tx); tv.verify_signature(tx)
print("    hash+signature OK (serializer-derived origin data, ecrecover vs from_address)")

# tamper with a signed tx exactly as an attacker would: change `value` in the JSON,
# keep the original signature, and feed it through the same deserialize+verify path
# that channel_inner_service / block_verifier use.
from loopchain.blockchain.transactions.v3 import TransactionSerializer as _TS
import json as _json
tx = build()
dumped = ts.to_full_data(tx)
dumped["value"] = hex(int(dumped["value"], 16) + 10 ** 18)
tampered = ts.from_(dict(dumped))
try:
    tv.verify_hash(tampered)
    tv.verify_signature(tampered)
    print("[2] !! tampered tx accepted")
except TransactionInvalidSignatureError:
    print("[2] tampered value w/ original signature -> TransactionInvalidSignatureError (rejected)")
except TransactionInvalidHashError:
    print("[2] tampered value -> TransactionInvalidHashError (rejected)")

# signature of a *different* key pasted onto this tx (forgery with foreign sig)
other = Signer.from_prikey(bytes.fromhex("33" * 32))
b = TransactionBuilder.new("0x3", "call", versioner)
b.signer = other
b.to_address = ExternalAddress.fromhex_address("hx" + "22" * 20); b.value = 10 ** 18
b.step_limit = 100000; b.nonce = 1; b.nid = 0x1; b.fixed_timestamp = 1_600_000_000_000_000
b.data_type = "call"; b.data = {"method": "x"}
foreign = b.build()
d2 = ts.to_full_data(tx); d2["signature"] = foreign.signature.to_base64str()
swapped = ts.from_(dict(d2))
try:
    tv.verify_signature(swapped); print("[3] !! foreign signature accepted")
except TransactionInvalidSignatureError:
    print("[3] foreign key's signature -> TransactionInvalidSignatureError (rejected)")

# nid binding: same tx signed for nid 1 must not verify against nid 0x1f
tx_nid1f = build(nid=0x1f)
try:
    tv_nid = TransactionVerifier(versioner.get_hash_generator_version("0x3"))
    from loopchain.blockchain.exception import TransactionInvalidNidError
    tv_nid.pre_verify(tx_nid1f, nid=0x1); print("    !! nid mismatch accepted")
except TransactionInvalidNidError:
    print("[4] nid mismatch -> TransactionInvalidNidError (rejected)")

# vote signature domain: block_hash + height + round are covered
class Rep:
    pass
rep = Signer.from_prikey(bytes.fromhex("22" * 32))
v = BlockVote.new(rep, 1_600_000_000_000_000, block_height=7, round_=0, block_hash=Hash32(b"\x01" * 32))
v.verify()
print("[5] block vote signature OK; signed fields:", sorted(k for k in v.to_origin_data(**v.origin_args())))
votes = BlockVotes(reps=[ExternalAddress.fromhex(rep.address)], voting_ratio=2/3,
                   block_height=7, round_=0, block_hash=Hash32(b"\x02" * 32))
try:
    votes.add_vote(v); print("    !! vote replayed onto a different block hash")
except RuntimeError as e:
    print("[6] vote replay onto different block hash ->", str(e).split('.')[0], "(rejected)")
