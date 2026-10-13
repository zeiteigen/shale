import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getRootSetting } from "../lib/settings";

const {values} = parseArgs({args:process.argv.slice(2),strict:true,options:{
  apply:{type:'boolean',default:false},'dry-run':{type:'boolean',default:false},
  'source-id':{type:'string'},profile:{type:'string',default:'local'},help:{type:'boolean',default:false},
}});
if (values.help) {
  console.log('bun scripts/repair-decorative-images.ts [--dry-run | --apply] [--source-id ID] [--profile local]');
} else {
  if (values.apply && values['dry-run']) throw new Error('Choose --apply or --dry-run');
  const original = process.env.SHALE_DB_PATH ? resolve(process.env.SHALE_DB_PATH) :
    resolve(import.meta.dir,'..',String(getRootSetting('SHALE_DB_PATH') ?? './data/production.db'));
  const temporary = values.apply ? undefined : mkdtempSync(join(tmpdir(),'shale-image-repair-'));
  const snapshot = temporary ? join(temporary,'preview.db') :
    join(dirname(original),'backups',`decorative-images-${Date.now()}-${process.pid}.db`);
  mkdirSync(dirname(snapshot),{recursive:true});
  const reader = new Database(original,{readonly:true});
  try { reader.run('VACUUM INTO ?', [snapshot]); chmodSync(snapshot,0o600); }
  finally { reader.close(); }
  // The preview SDK operates on a snapshot; imports cannot initialize the original database.
  process.env.SHALE_DB_PATH = temporary ? snapshot : original;
  try {
    const {createScopedSDK,closeScopedSDKs} = await import('../sdk/access');
    const {createExtensionSDK} = await import('../sdk/extension-sdk');
    const {findDecorativeRepairs} = await import('../extensions/obsidian/decorative-repair');
    const {applyDecorativeRepair} = await import('../extensions/obsidian/apply-decorative-repair');
    const access = createScopedSDK(values.profile!,createExtensionSDK('obsidian',{
      namespace:'obsidian',extensionDir:resolve(import.meta.dir,'../extensions/obsidian'),
    }));
    const repairs = findDecorativeRepairs(access.read,values['source-id']);
    console.log(JSON.stringify({mode:values.apply?'apply':'dry-run',sources:repairs.map(r=>({
      sourceId:r.sourceId,title:r.title,decorativeRelationships:r.claims.length,generatedMemoryDirty:r.generatedMemoryDirty,
    })),...(values.apply?{backup:snapshot}:{})},null,2));
    let failures = 0;
    if (values.apply) {
      if (access.refresh().write===false) throw new Error('The access profile is read-only');
      for (const repair of repairs) {
        try {
          const receipt=await applyDecorativeRepair(access.write,repair);
          console.log(JSON.stringify({sourceId:receipt.sourceId,retractedClaims:receipt.retractedClaims,
            memoryVersion:receipt.memoryVersion,...('auditChangeId' in receipt?{auditChangeId:receipt.auditChangeId}:{})}));
        }
        catch (error) { failures++; console.error(JSON.stringify({sourceId:repair.sourceId,error:String(error)})); }
      }
    }
    closeScopedSDKs();
    access.read.database.close();
    if (failures) process.exitCode=1;
  } finally { if (temporary) rmSync(temporary,{recursive:true,force:true}); }
}
