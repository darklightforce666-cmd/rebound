const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>['node_modules','.git','test-results','target','artifact','__pycache__','.pytest_cache'].includes(e.name)?[]:e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);}
test('published interface does not advertise superseded reward economics',()=>{
  // Protocol field names (including Pump buyback fees) and explanatory docs are
  // evidence, not product allocations. Audit shipped UI copy for old economics.
  const banned=[/80% (?:holders|of net)/i,/80 \/ 15 \/ 5/,/5% (?:platform )?buyback/i];
  for(const file of files(path.join(root,'src')))if(/\.(html|js|css)$/.test(file)){
    const text=fs.readFileSync(file,'utf8');for(const term of banned)assert.ok(!term.test(text),path.relative(root,file)+' contains '+term);
  }
});
