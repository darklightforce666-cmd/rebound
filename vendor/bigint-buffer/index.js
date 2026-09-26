'use strict';
// Same API as bigint-buffer (toBigIntLE/BE, toBufferLE/BE), pure JavaScript.
function toBigIntBE(buf){const hex=Buffer.from(buf).toString('hex');return hex.length===0?0n:BigInt('0x'+hex);}
function toBigIntLE(buf){const r=Buffer.from(buf);r.reverse();return toBigIntBE(r);}
function toBufferBE(num,width){const hex=BigInt(num).toString(16);return Buffer.from(hex.padStart(width*2,'0').slice(0,width*2),'hex');}
function toBufferLE(num,width){const b=toBufferBE(num,width);b.reverse();return b;}
module.exports={toBigIntBE,toBigIntLE,toBufferBE,toBufferLE};
