const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync(__dirname + '/apple-tv-watchdog.js','utf8');
function fixture() {
    const vars={}; let now=10000000, device={available:false,ready:true}, readError=false;
    const f={
        advance: ms=>now+=ms,
        device: value=>device=value,
        error: value=>readError=value,
        value: suffix=>Object.values(vars).find(v=>v.name.endsWith(' '+suffix))?.value,
        corrupt: (suffix,value)=>Object.values(vars).find(v=>v.name.endsWith(' '+suffix)).value=value,
        run: ()=>vm.runInNewContext('(async()=>{'+code+'})()', {
            Date: class extends Date {static now(){return now;} constructor(...args){super(...(args.length?args:[now]));}},
            Homey:{
                logic:{
                    getVariables:async()=>structuredClone(vars),
                    createVariable:async({variable})=>{const v={id:String(Object.keys(vars).length),...variable};vars[v.id]=v;return structuredClone(v);},
                    updateVariable:async({id,variable})=>Object.assign(vars[id],variable)
                },
                devices:{getDevice:async({id})=>{assert.equal(id,'6d4183e8-a31e-4809-9b77-cddbea3958c5');if(readError)throw Error('read');return device;}}
            }
        })
    }; return f;
}
async function minutes(f,n){for(let i=0;i<n;i++){f.advance(60000);assert.equal(await f.run(),false);}}
test('healthy and paused state never requests recovery',async()=>{const f=fixture();f.device({available:true,ready:true,speaker_playing:false});assert.equal(await f.run(),false);assert.equal(f.value('Status'),'Healthy');});
test('no restart before five minutes, eligible at threshold, cooldown retained',async()=>{const f=fixture();assert.equal(await f.run(),false);await minutes(f,4);f.advance(59999);assert.equal(await f.run(),false);f.advance(1);assert.equal(await f.run(),true);f.advance(60000);assert.equal(await f.run(),false);assert.match(f.value('Status'),/cooldown/);});
test('healthy reconnect resets timer',async()=>{const f=fixture();await f.run();await minutes(f,4);f.device({available:true,ready:true});f.advance(60000);await f.run();f.device({available:false,ready:true});f.advance(60000);assert.equal(await f.run(),false);await minutes(f,4);});
test('unknown availability resets confirmation',async()=>{const f=fixture();await f.run();await minutes(f,4);f.device({});f.advance(60000);assert.equal(await f.run(),false);assert.equal(f.value('Unavailable Since'),0);});
test('read error resets confirmation',async()=>{const f=fixture();await f.run();await minutes(f,4);f.error(true);f.advance(60000);assert.equal(await f.run(),false);assert.equal(f.value('Unavailable Since'),0);});
test('missing check gap cannot count as five minutes offline',async()=>{const f=fixture();await f.run();f.advance(300000);assert.equal(await f.run(),false);await minutes(f,4);});
test('backward clock resets timer',async()=>{const f=fixture();await f.run();f.advance(-1000);assert.equal(await f.run(),false);assert.equal(f.value('Unavailable Since'),9999000);});
test('not-ready is explicit failure; cooldown expires only after 30 minutes',async()=>{const f=fixture();f.device({available:true,ready:false});await f.run();await minutes(f,4);f.advance(60000);assert.equal(await f.run(),true);await minutes(f,29);f.advance(60000);assert.equal(await f.run(),true);});
test('malformed history and numeric state fail closed',async()=>{for(const [suffix,value] of [['History','{}'],['Last Restart',NaN]]){const f=fixture();await f.run();f.corrupt(suffix,value);await assert.rejects(f.run(),/Invalid watchdog/);}});

