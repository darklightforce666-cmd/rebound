"""Instruction builders only. No private keys, network calls, or transaction submission."""
import base64
import json
import struct
from pathlib import Path
from solders.pubkey import Pubkey
from solders.instruction import AccountMeta, Instruction

SYSTEM = Pubkey.default()
def key(value):
    return value if isinstance(value, Pubkey) else Pubkey.from_string(value)
def meta(address, signer=False, writable=False):
    return AccountMeta(key(address), signer, writable)
def u64(value):
    return struct.pack('<Q', int(value))
def vault_address(program, admin, mint):
    return Pubkey.find_program_address([b'rebound', bytes(key(admin)), bytes(key(mint))], key(program))[0]
def round_address(program, vault, round_id):
    return Pubkey.find_program_address([b'round', bytes(key(vault)), u64(round_id)], key(program))[0]
def receipt_address(program, round_account, wallet):
    return Pubkey.find_program_address([b'claim', bytes(key(round_account)), bytes(key(wallet))], key(program))[0]
def initialize(program, admin, mint, publisher, guardian, operations):
    vault=vault_address(program,admin,mint)
    return Instruction(key(program), b'\0'+bytes(key(publisher))+bytes(key(guardian))+bytes(key(operations)), [meta(admin,True,True),meta(vault,False,True),meta(mint),meta(SYSTEM)])
def deposit(program, payer, vault, operations, amount):
    return Instruction(key(program), b'\1'+u64(amount), [meta(payer,True,True),meta(vault,False,True),meta(operations,False,True),meta(SYSTEM)])
def sync(program, vault, operations):
    return Instruction(key(program), b'\2', [meta(vault,False,True),meta(operations,False,True)])
def publish(program, publisher, vault, bundle):
    if bundle['programId']!=str(program) or bundle['config']!=str(vault):
        raise ValueError('Round targets another program or vault')
    data=b'\3'+u64(bundle['roundId'])+bytes.fromhex(bundle['root'])+u64(bundle['total'])+struct.pack('<q',bundle['snapshotAt'])+bytes.fromhex(bundle['manifestHash'])
    return Instruction(key(program),data,[meta(publisher,True,True),meta(vault,False,True),meta(round_address(program,vault,bundle['roundId']),False,True),meta(SYSTEM)])
def cancel(program, guardian, vault, round_id):
    return Instruction(key(program),b'\4',[meta(guardian,True),meta(vault,False,True),meta(round_address(program,vault,round_id),False,True)])
def claim(program, payer, vault, round_id, award):
    proof=award['proof']
    if len(proof)>16: raise ValueError('Proof exceeds contract limit')
    data=b'\5'+u64(award['amount'])+bytes([len(proof)])
    for node in proof:
        h=bytes.fromhex(node['hash'])
        if len(h)!=32: raise ValueError('Invalid proof hash')
        data+=h+u64(node['sum'])
    wallet=key(award['wallet']);round_account=round_address(program,vault,round_id)
    return Instruction(key(program),data,[meta(payer,True,True),meta(vault,False,True),meta(round_account,False,True),meta(wallet,False,True),meta(receipt_address(program,round_account,wallet),False,True),meta(SYSTEM)])
def pause(program, actor, vault, paused=True):
    return Instruction(key(program),b'\6'+bytes([int(paused)]),[meta(actor,True),meta(vault,False,True)])
def propose_publisher(program, admin, vault, publisher):
    return Instruction(key(program),b'\7'+bytes(key(publisher)),[meta(admin,True),meta(vault,False,True)])
def activate_publisher(program, vault):
    return Instruction(key(program),b'\10',[meta(vault,False,True)])
def instruction_json(ix):
    return {'programId':str(ix.program_id),'accounts':[{'pubkey':str(m.pubkey),'isSigner':m.is_signer,'isWritable':m.is_writable} for m in ix.accounts],'dataBase64':base64.b64encode(ix.data).decode()}
def read_config(data):
    if len(data)!=281 or data[:8]!=b'RBDCFG01': raise ValueError('Not a REBOUND config')
    names=['admin','mint','publisher','guardian','operations','pendingPublisher']
    c={name:str(Pubkey.from_bytes(data[8+i*32:40+i*32])) for i,name in enumerate(names)}
    c['publisherAt']=struct.unpack_from('<q',data,200)[0];c['paused']=bool(data[208])
    for i,name in enumerate(['available','reserved','paid','collected','operationsPaid','dust','nextRound']): c[name]=struct.unpack_from('<Q',data,209+8*i)[0]
    c['pendingUntil'],c['latestSnapshot']=struct.unpack_from('<qq',data,265)
    return c

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description='Prepare unsigned REBOUND initialization; never deploys or sends funds.')
    parser.add_argument('settings');parser.add_argument('output');args=parser.parse_args()
    settings=json.loads(Path(args.settings).read_text())
    fields=['programId','admin','mint','publisher','guardian','operations']
    missing=[f for f in fields if not settings.get(f)]
    if missing: parser.error('Supply public addresses later: '+', '.join(missing))
    keys={f:key(settings[f]) for f in fields}
    if any(not keys[f].is_on_curve() for f in ['admin','publisher','guardian','operations']): parser.error('Version 1 requires ordinary signing wallets for the configured roles')
    vault=vault_address(keys['programId'],keys['admin'],keys['mint'])
    ix=initialize(keys['programId'],keys['admin'],keys['mint'],keys['publisher'],keys['guardian'],keys['operations'])
    Path(args.output).write_text(json.dumps({'cluster':settings.get('cluster','devnet'),'vault':str(vault),'policy':'holder-recovery/v2','payoutSchedule':'hourly UTC','initialize':instruction_json(ix)},indent=2)+'\n')
    print('Unsigned initialization prepared. No network call or transaction was sent.')
