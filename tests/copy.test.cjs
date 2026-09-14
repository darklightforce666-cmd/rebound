const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>['node_modules','.git','test-results'].includes(e.name)?[]:e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);}
test('copy, source, fixtures, docs, vector assets, and preview pass terminology audit',()=>{
  const banned=[new RegExp('USD'+'G','i'),new RegExp('eligible'+'\\s+holders?','i'),/[\u2013\u2014]/,/&(?:mdash|ndash);/i];
  for(const file of files(root))if(/\.(html|css|js|cjs|md|svg|json)$/.test(file)){
    const text=fs.readFileSync(file,'utf8');for(const term of banned)assert.ok(!term.test(text),path.relative(root,file)+' contains '+term);
  }
});
