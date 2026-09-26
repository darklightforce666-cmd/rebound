'use strict';
// Vendored pure-JS bigint-buffer (see pnpm-workspace.yaml override) must match the upstream API.
const test=require('node:test'),assert=require('node:assert/strict'),B=require('../vendor/bigint-buffer');
test('bigint-buffer shim: LE/BE conversions, zero-length, width padding and truncation match upstream semantics',()=>{
 assert.equal(B.toBigIntLE(Buffer.from([0x01,0x02])),0x0201n);assert.equal(B.toBigIntBE(Buffer.from([0x01,0x02])),0x0102n);
 assert.equal(B.toBigIntLE(Buffer.alloc(0)),0n);assert.equal(B.toBigIntBE(Buffer.alloc(0)),0n);
 assert.deepEqual([...B.toBufferLE(0x0102n,4)],[2,1,0,0]);assert.deepEqual([...B.toBufferBE(0x0102n,4)],[0,0,1,2]);
 assert.deepEqual([...B.toBufferBE(0x010203n,2)],[0x10,0x20]);                                   // mirrors upstream's hex truncation for overflowing widths
 for(const v of [0n,1n,255n,256n,2n**64n-1n,12345678901234567890n]){assert.equal(B.toBigIntLE(B.toBufferLE(v,8+(v>=2n**64n?8:0))),v);assert.equal(B.toBigIntBE(B.toBufferBE(v,16)),v);}
 // Real consumer: spl-token (via @solana/buffer-layout-utils) decodes a u64 mint supply through the shim.
 const {MintLayout}=require('@solana/spl-token');const buf=Buffer.alloc(MintLayout.span);buf.writeBigUInt64LE(2n**63n+5n,36);assert.equal(MintLayout.decode(buf).supply,2n**63n+5n);
});
