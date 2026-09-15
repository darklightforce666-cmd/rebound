const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),dist=path.join(root,'dist');
function build(){
 // Only this fixed, generated directory may be cleared.
 if(path.dirname(dist)!==root||path.basename(dist)!=='dist')throw Error('Invalid output path');
 fs.rmSync(dist,{recursive:true,force:true});
 const files=['index.html','src/mainnet-config.js','src/live-data.js','src/wallet.js','src/app.js','src/styles.css','src/solana.css','src/motion.css','src/live.css','src/motion.js'];
 for(const file of files){
  const target=path.join(dist,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,file),target);
 }
 fs.cpSync(path.join(root,'assets'),path.join(dist,'assets'),{recursive:true});
 require('esbuild').buildSync({entryPoints:[path.join(root,'src/rewards-entry.js')],outfile:path.join(dist,'src/rewards.js'),bundle:true,platform:'browser',target:['es2022'],minify:true,define:{'process.env.NODE_ENV':'"production"'},logLevel:'warning'});
 console.log('Built dist with live interface assets. Server code and test data are excluded.');
}
if(require.main===module)build();
module.exports={build};
