import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionSDK,createMessageBus,type ShaleSDK } from "../sdk";
import { createTestDatabase } from "./fixtures/database";
import { discordConnector } from "../extensions/discord/connector";
import { DiscordRelevancePolicy, matchesDiscordTopics } from "../extensions/discord/relevance";
import { run } from "../extensions/discord";
import { run as recover } from "../extensions/discord/recover";
import { run as sync } from "../extensions/discord/sync";
import { syncDiscordREST } from "../extensions/discord/rest-sync";
import { run as reclassify } from "../extensions/discord/reclassify";
import { rawArchiveStats,trimDiscordArchive } from "../extensions/discord/archive";
import { getGraphData } from "../visualizer/graph-data";
import { setup } from "../extensions/discord/refresh";
import { discordIdentity } from "../extensions/discord/identity";
import { DiscordAPI } from "../extensions/discord/api";
import { searchDiscordActivity } from "../extensions/discord/activity-search";
import { restoreDiscordWindow } from "../extensions/discord/refresh-archive";
import { fetchReferencedContext } from "../extensions/discord/reference-context";
import { backfillDiscord } from "../extensions/discord/backfill";
import { refreshInterests } from "../extensions/discord/interests";
import { closeScopedSDKs } from "../sdk/access";
import { ensureAccessSchema, setLabel } from "../lib/access/schema";
import type { ChatConversation,ChatMessage } from "../sdk/chat/types";

const T0=Date.now()-2*86_400_000;
const conversation:ChatConversation={conversationId:'200',title:'#general',kind:'channel',uri:'discord://channel/200',
  server:{id:'100',name:'Community',uri:'discord://guild/100'}};
const message=(id:string,minute:number,text:string,authorId='2',extra:Partial<ChatMessage>={}):ChatMessage=>({
  messageId:id,authorId,authorName:authorId==='1' ? 'Me' : authorId==='2' ? 'Bob' : 'Incidental',
  text,sentAt:T0+minute*60_000,attachments:[],...extra});
let directory:string,db:ReturnType<typeof createTestDatabase>,sdk:ShaleSDK;
let config:Record<string,unknown>,previousPath:string|undefined,classificationCalls:number;
const realFetch=globalThis.fetch;
function configure(extra:Record<string,unknown>={}) {
  config={...config,...extra};writeFileSync(join(directory,'settings.json'),JSON.stringify(config));
}
function ingest(messages:ChatMessage[],conv=conversation) {
  const connector=discordConnector(sdk);
  connector.policy?.ingest?.(conv,messages) ?? connector.store.ingest(conv,messages);
  return connector;
}
const count=(table:string)=>db.query<{n:number},[]>(`SELECT count(*) AS n FROM ${table}`).get()!.n;

beforeEach(()=>{
  directory=mkdtempSync(join(tmpdir(),'shale-discord-relevance-'));
  previousPath=process.env.SHALE_CREDENTIALS_PATH;process.env.SHALE_CREDENTIALS_PATH=join(directory,'credentials.json');
  db=createTestDatabase();sdk=createExtensionSDK('discord',{database:db,messageBus:createMessageBus(),extensionDir:directory});
  sdk.logger.log=()=>{};sdk.logger.warn=()=>{};sdk.logger.error=()=>{};
  config={selfUserIds:['1'],importDir:join(directory,'imports'),summarize:false,rawRetentionDays:36500,relevanceEnabled:true,
    syncScope:'selected',channels:['200'],includeThreads:'none',relevanceMaxWindows:50};configure();
  classificationCalls=0;
  sdk.queryLLM=(async(prompt:string)=>{
    if(prompt.startsWith('Infer'))return JSON.stringify({topics:[]});
    classificationCalls++;return JSON.stringify({score:.95,reason:'Useful SQLite migration context',participantIds:['2']});
  }) as typeof sdk.queryLLM;
});
afterEach(()=>{
  globalThis.fetch=realFetch;sdk.messages.clear();db.close();rmSync(directory,{recursive:true,force:true});
  if(previousPath===undefined)delete process.env.SHALE_CREDENTIALS_PATH;else process.env.SHALE_CREDENTIALS_PATH=previousPath;
});

describe('Discord relevance',()=>{
  test('topical candidates ignore common words and retain short technical interests',()=>{
    expect(matchesDiscordTopics('the weather and our next meeting',['ML and scientific computing'])).toBe(false);
    expect(matchesDiscordTopics('ML experiments',['ML and scientific computing'])).toBe(true);
    expect(matchesDiscordTopics('AI model design',['AI'])).toBe(true);
  });
  test('filters public chatter while admitting direct involvement and substantive contributors',async()=>{
    ingest([message('10',0,'hello everyone'),message('11',1,'ok','3'),
      message('20',180,'Can we discuss the release?','1'),message('21',181,'This release needs a staged rollout and careful validation. '.repeat(3)),
      message('22',182,'ok','3')]);
    await run(sdk);
    expect(count('sources')).toBe(1);
    expect(db.query<{name:string},[]>("SELECT display_name AS name FROM entities WHERE type='Person'").all().map(row=>row.name).sort()).toEqual(['Bob','Me']);
    expect(count('discord_messages')).toBe(5);
    expect(classificationCalls).toBe(0);
  });

  test('uses the LLM for topical discussions, validates author IDs and caches unchanged decisions',async()=>{
    configure({interests:['SQLite']});
    ingest([message('30',0,'SQLite migrations need to preserve foreign keys and transaction boundaries. '.repeat(2)),message('31',1,'ok','3')]);
    sdk.queryLLM=(async(prompt:string)=>prompt.startsWith('Infer') ? JSON.stringify({topics:[]})
      : (classificationCalls++,`\`\`\`json\n${JSON.stringify({score:.9,reason:'SQLite migration details',participantIds:['2','invented']})}\n\`\`\``)) as typeof sdk.queryLLM;
    await run(sdk);expect(count('sources')).toBe(1);expect(classificationCalls).toBe(1);
    expect(db.query("SELECT 1 FROM graph_aliases WHERE alias='invented'").get()).toBeNull();
    await run(sdk);expect(classificationCalls).toBe(1);
  });

  test('drains legacy cleanup in bounded batches without importing or syncing',async()=>{
    configure({relevanceEnabled:false});
    ingest([message('cleanup-a',0,'chatter'),message('cleanup-b',180,'chatter'),message('cleanup-c',360,'chatter')]);
    await run(sdk);expect(count('sources')).toBe(3);
    configure({relevanceEnabled:true,relevanceMaxWindows:1});
    sdk.queryLLM=(async(prompt:string)=>prompt.startsWith('Infer') ? '```json\n{"topics":[]}\n```'
      : '```json\n{"score":0,"reason":"Chatter","participantIds":[]}\n```') as typeof sdk.queryLLM;
    const result=await reclassify(sdk,{drain:true});
    expect(result!.windows).toBe(3);expect(result!.batches).toBe(4);
    expect(count('sources')).toBe(0);expect(count('discord_messages')).toBe(3);
    expect(sdk.state.getJson('relevance:cleanup')).toMatchObject({windows:3,excluded:3});
  });

  test('a cleanup drain renews the model budget between batches without leaving budget deferrals stranded',async()=>{
    configure({interests:['SQLite'],relevanceMaxWindows:3,relevanceMaxLLMCalls:1});
    ingest([message('budget-a',0,'SQLite migrations are worth understanding.'),message('budget-b',180,'SQLite transaction isolation.'),
      message('budget-c',360,'SQLite foreign key enforcement.')]);
    const result=await reclassify(sdk,{drain:true});
    expect(classificationCalls).toBe(3);expect(count('sources')).toBe(3);
    expect(result!.batches).toBe(4);
    expect(db.query("SELECT 1 FROM discord_relevance WHERE status='pending'").get()).toBeNull();
  });

  test('later participation reconsiders prior related context without admitting unrelated history',async()=>{
    sdk.queryLLM=(async(prompt:string)=>prompt.startsWith('Infer') ? JSON.stringify({topics:[]})
      : JSON.stringify({score:.95,reason:'Earlier conversation with a new contact',participantIds:['2']})) as typeof sdk.queryLLM;
    ingest([message('40',0,'There are useful details about the project plan. '.repeat(3)),
      message('50',180,'lol','3')]);await run(sdk);expect(count('sources')).toBe(0);
    ingest([message('41',2,'I would like to join this discussion.','1',{replyToId:'40'})]);
    await run(sdk);expect(count('sources')).toBe(1);
    expect(db.query<{text:string},[]>("SELECT group_concat(text_content) AS text FROM chunks").get()!.text).toContain('project plan');
    expect(count('discord_promotions')).toBe(1);
  });

  test('joining a previously excluded thread promotes starter context without promoting its whole parent channel',async()=>{
    const thread={...conversation,conversationId:'300',kind:'thread' as const,uri:'discord://channel/300',parentId:'200'};
    const connector=ingest([message('300',0,'Earlier useful thread starter. '.repeat(5))],thread);
    ingest([message('60',0,'Random public chatter')]);await run(sdk);expect(count('sources')).toBe(0);
    (connector.policy as DiscordRelevancePolicy).state.promote('300','joined',Date.now(),'','joined');
    await run(sdk);expect(count('sources')).toBe(1);
    expect(db.query<{uri:string},[]>("SELECT uri FROM sources").get()!.uri).toContain('channel/300');
  });

  test('mentions, reactions and replies qualify while explicit exclusions win',async()=>{
    configure({excludedConversations:['200']});
    ingest([message('70',0,'Hello','2',{mentionedUserIds:['1'],reactedUserIds:['1']})]);await run(sdk);
    expect(count('sources')).toBe(0);
    configure({excludedConversations:[]});await run(sdk);expect(count('sources')).toBe(1);
    ingest([message('71',1,'I replied','1'),message('72',2,'Reply to you','2',{replyToId:'71'})]);await run(sdk);
    expect(count('sources')).toBe(1);
  });

  test('missing identity and classifier failure remain pending without destructive cleanup',async()=>{
    configure({selfUserIds:[],interests:['SQLite']});
    ingest([message('80',0,'SQLite migrations are useful. '.repeat(4))]);await run(sdk);
    expect(count('sources')).toBe(0);expect(classificationCalls).toBe(0);
    expect(db.query<{status:string},[]>("SELECT status FROM discord_relevance").get()!.status).toBe('pending');
    configure({selfUserIds:['1']});sdk.queryLLM=(async()=>{throw new Error('offline');}) as typeof sdk.queryLLM;
    await run(sdk);expect(db.query<{status:string},[]>("SELECT status FROM discord_relevance").get()!.status).toBe('pending');
    expect(count('discord_messages')).toBe(1);
  });

  test('reclassifies existing sources and retires unsupported entities from current discovery',async()=>{
    configure({relevanceEnabled:false});ingest([message('90',0,'Random old chatter. '.repeat(8))]);await run(sdk);
    const person=db.query<{id:number},[]>("SELECT id FROM entities WHERE type='Person'").get()!.id;
    expect(count('sources')).toBe(1);
    configure({relevanceEnabled:true});await run(sdk);
    expect(count('sources')).toBe(0);expect(getGraphData(sdk).nodes).toHaveLength(0);
    expect(sdk.graph.entities.resolve('Bob')).toHaveLength(0);
    expect(sdk.graph.entities.get(person).name).toBe('Bob');
    expect((await sdk.knowledge.read('list_entities',{})) as {total:number}).toMatchObject({total:0});
    expect(getGraphData(sdk,{statuses:['retracted']}).nodes.length).toBeGreaterThan(0);
    ingest([message('91',1,'I am joining this discussion','1')]);await run(sdk);
    expect(count('sources')).toBe(1);expect(sdk.graph.entities.resolve('Bob')).toHaveLength(1);
  });

  test('preserves independently supported and manually maintained people during cleanup',async()=>{
    configure({relevanceEnabled:false});ingest([message('100',0,'Public chatter. '.repeat(10))]);await run(sdk);
    const person=sdk.graph.entities.resolve('Bob')[0]!;
    sdk.graph.claims.add({subject:person.id,predicate:'NOTE',value:'A personal contact',status:'accepted',method:'manual'});
    configure({relevanceEnabled:true});await run(sdk);
    expect(count('sources')).toBe(0);expect(sdk.graph.entities.resolve('Bob')).toHaveLength(1);
  });

  test('selection changes preserve source identity and remove incidental author projections',async()=>{
    configure({relevanceEnabled:false});ingest([message('110',0,'Hello','1'),message('111',1,'ok','3')]);await run(sdk);
    const source=db.query<{id:string},[]>("SELECT id FROM sources").get()!.id;
    configure({relevanceEnabled:true});await run(sdk);
    expect(db.query<{id:string},[]>("SELECT id FROM sources").get()!.id).toBe(source);
    expect(sdk.graph.entities.resolve('Incidental')).toHaveLength(0);
    expect(getGraphData(sdk).nodes.filter(node=>node.type==='Person').map(node=>node.name)).toEqual(['Me']);
  });

  test('discards stale admission checkpoints after policy changes and recovers valid ones without a model',async()=>{
    ingest([message('120',0,'A conversation with me','1')]);
    const original=sdk.ingest.sourceAndChunks.bind(sdk.ingest);
    sdk.ingest.sourceAndChunks=()=>{throw new Error('disk full');};await run(sdk);expect(count('checkpoints')).toBe(1);
    sdk.ingest.sourceAndChunks=original;configure({excludedConversations:['200']});
    await recover(sdk);expect(count('sources')).toBe(0);expect(count('checkpoints')).toBe(0);
    configure({excludedConversations:[]});sdk.ingest.sourceAndChunks=()=>{throw new Error('disk full');};await run(sdk);
    sdk.ingest.sourceAndChunks=original;sdk.queryLLM=(async()=>{throw new Error('must not call model');}) as typeof sdk.queryLLM;
    expect(await recover(sdk)).toEqual({recoveredWindows:1});
  });

  test('evicts complete settled raw windows while retaining searchable summaries and detecting incomplete refresh',async()=>{
    configure({rawRetentionDays:1});ingest([message('130',0,'My prior discussion','1')]);await run(sdk);
    expect(count('sources')).toBe(1);expect(count('discord_messages')).toBe(0);expect(rawArchiveStats(discordConnector(sdk).store).bytes).toBe(0);
    setup(sdk);const source=db.query<{id:string},[]>("SELECT id FROM sources").get()!.id;
    const result=await sdk.messages.request('source:refresh',{sourceId:source,actor:'test',reason:'Verify archive eviction'});
    expect(result.status).toBe('unavailable');expect(count('sources')).toBe(1);
  });

  test('eviction preserves and rescans a pending window sharing the evicted window timestamp',async()=>{
    configure({interests:['SQLite'],rawRetentionDays:1,maxWindowMessages:1,relevanceMaxLLMCalls:1});
    const connector=ingest([message('evict-a',0,'SQLite migrations'),message('evict-b',0,'SQLite transactions')]);
    await run(sdk);
    expect(connector.store.loadMessages('200',['evict-a'])).toHaveLength(0);
    expect(connector.store.loadMessages('200',['evict-b'])).toHaveLength(1);
    const pending=db.query<{window_id:string},[]>("SELECT window_id FROM discord_relevance WHERE status='pending'").get()!;
    connector.store.deferWindow(pending.window_id,0);
    await run(sdk);
    expect(count('sources')).toBe(2);expect(count('discord_messages')).toBe(0);
  });

  test('excluded personal search hits advance the cursor without fetching or retaining the channel',async()=>{
    configure({syncScope:'all',excludedConversations:['200']});
    const connector=discordConnector(sdk),state=(connector.policy as DiscordRelevancePolicy).state;
    const id='9999999999999999999';let calls=0;
    globalThis.fetch=(async(input:RequestInfo|URL)=>{
      calls++;expect(new URL(String(input)).pathname).toEndWith('/guilds/100/messages/search');
      return Response.json({messages:[[{id,channel_id:'200',type:0,timestamp:new Date(T0).toISOString(),content:'Excluded activity',author:{id:'1',username:'Me'}}]]});
    }) as typeof fetch;
    await searchDiscordActivity(new DiscordAPI('fake','user',{requests:3,messages:10,deadline:Date.now()+10000}),
      sdk,connector,sdk.settings.getAll(),state,[{id:'100',name:'Community'}],'1');
    expect(calls).toBe(3);expect(count('discord_messages')).toBe(0);expect(count('discord_promotions')).toBe(0);
    for(const mode of ['author_id','mentions','replied_to_user_id'])expect(sdk.state.get(`rest:activity:100:${mode}`)).toBe(id);
  });

  test('an interest-inference outage preserves existing public Discord history',async()=>{
    configure({relevanceEnabled:false});ingest([message('90',0,'Random old chatter. '.repeat(8))]);await run(sdk);
    sdk.ingest.sourceAndChunks({source:{id:'interest-note',uri:'note://interests',origin:'obsidian',type:'note',title:'Research interests'},
      chunks:[{chunk_index:0,chunk_type:'verbatim',text_content:'Research interests'}]});
    configure({relevanceEnabled:true});sdk.queryLLM=(async()=>{throw new Error('offline');}) as typeof sdk.queryLLM;
    await run(sdk);
    expect(sdk.context.getSources({origin:'discord'})).toHaveLength(1);
    expect(db.query<{status:string;reason:string},[]>("SELECT status,reason FROM discord_relevance").get()).toMatchObject({
      status:'pending',reason:'Interest inference pending; relevance evidence unavailable'});
  });

  test('on-demand archive restoration obeys its message budget',async()=>{
    configure({rawRetentionDays:1,syncMaxMessages:1});
    const connector=ingest([message('501',0,'My discussion','1'),message('502',1,'My follow-up','1')]);await run(sdk);
    expect(count('discord_messages')).toBe(0);
    sdk.credentials.set({kind:'user',userId:'1',token:'fake'});
    let calls=0;globalThis.fetch=(async(input:RequestInfo|URL)=>{
      calls++;return Response.json({id:new URL(String(input)).pathname.split('/').at(-1),channel_id:'200',type:0,
        timestamp:new Date(T0).toISOString(),content:'Restored context',author:{id:'1',username:'Me'}});
    }) as typeof fetch;
    const window=db.query<{window_id:string},[]>("SELECT window_id FROM discord_windows").get()!;
    await restoreDiscordWindow(sdk,connector.store,(connector.policy as DiscordRelevancePolicy).state,sdk.settings.getAll(),window.window_id);
    expect(calls).toBe(1);expect(count('discord_messages')).toBe(1);
  });

  test('capacity-rejected referenced context remains incomplete for retry',async()=>{
    configure({rawMaxConversationMessages:1});
    const connector=ingest([message('499',0,'Pinned existing context','1')]),state=(connector.policy as DiscordRelevancePolicy).state;
    globalThis.fetch=(async()=>Response.json({id:'500',channel_id:'200',type:0,timestamp:new Date(T0).toISOString(),
      content:'Missing referenced context',author:{id:'2',username:'Bob'}})) as unknown as typeof fetch;
    const complete=await fetchReferencedContext(new DiscordAPI('fake','user',{requests:5,messages:5,deadline:Date.now()+10000}),
      sdk,connector,sdk.settings.getAll(),state,{...conversation,conversationId:'300'},
      [message('301',0,'Reply','1',{replyToId:'500',replyConversationId:'200'})],'1');
    expect(complete).toBe(false);expect(connector.store.loadMessages('200',['500'])).toHaveLength(0);
  });

  test('capacity-rejected incremental activity holds its cursor and reports incomplete coverage',async()=>{
    configure({rawMaxConversationMessages:1});sdk.credentials.set({kind:'user',userId:'1',token:'fake'});
    const connector=ingest([message('1999',0,'Existing sample')]);sdk.state.set('rest:channel:200','1999');
    globalThis.fetch=(async(input:RequestInfo|URL)=>{
      const url=new URL(String(input));
      if(url.pathname.endsWith('/channels/200'))return Response.json({id:'200',type:0,name:'general',guild_id:'100'});
      if(url.pathname.endsWith('/guilds/100'))return Response.json({id:'100',name:'Community'});
      if(url.pathname.endsWith('/guilds/100/messages/search'))return Response.json({messages:[]});
      if(url.pathname.endsWith('/channels/200/messages'))return Response.json([{id:'2000',channel_id:'200',type:0,
        timestamp:new Date(T0+60000).toISOString(),content:'Deferred activity',author:{id:'2',username:'Bob'}}]);
      throw new Error(`Unexpected route ${url.pathname}`);
    }) as typeof fetch;
    const result=await syncDiscordREST(sdk,connector,sdk.settings.getAll(),Date.now()+10000,async()=>{});
    expect(result.errors).toEqual([]);expect(result.incomplete).toBeGreaterThan(0);
    expect(sdk.state.get('rest:channel:200')).toBe('1999');
    expect(db.query<{mode:string},[]>("SELECT mode FROM discord_coverage WHERE conversation_id='200'").get()!.mode).toBe('incomplete');
    expect(connector.store.loadMessages('200',['2000'])).toHaveLength(0);
  });

  test('archive admission and run limits bound work even for a single noisy channel',async()=>{
    configure({rawMaxConversationMessages:3,rawMaxMiB:.001,relevanceMaxWindows:1});
    ingest([message('140',0,'Short','1'),message('141',180,'Short','1'),message('142',360,'Short','1'),message('143',540,'Short','1')]);
    expect(count('discord_messages')).toBeLessThanOrEqual(3);expect(rawArchiveStats(discordConnector(sdk).store).bytes).toBeLessThanOrEqual(1024*1.024);
    const result=await run(sdk);expect(result!.indexed.windows).toBe(1);expect(count('sources')).toBe(1);
  });

  test('bot credentials never supply the human identity',()=>{
    sdk.credentials.set({kind:'bot',userId:'bot',token:'fake'});configure({selfUserIds:[]});
    expect(discordIdentity(sdk,sdk.settings.getAll())).toEqual([]);
    configure({selfUserIds:['1']});expect(discordIdentity(sdk,sdk.settings.getAll())).toEqual(['1']);
  });

  test('keeps old raw history until the bounded reclassification pass has decided its windows',async()=>{
    configure({relevanceEnabled:false});
    const old=T0-90*86_400_000;
    ingest([message('160',0,'Old public chatter','2',{sentAt:old}),
      message('161',180,'Another old conversation','2',{sentAt:old+180*60_000})]);await run(sdk);
    configure({relevanceEnabled:true,rawRetentionDays:30,relevanceMaxWindows:1});
    await run(sdk);
    expect(count('sources')).toBe(1);expect(count('discord_messages')).toBe(1);
    await run(sdk);expect(count('sources')).toBe(0);expect(count('discord_messages')).toBe(0);
  });

  test('REST sync shares message and request budgets with contextual backfill',async()=>{
    sdk.credentials.set({kind:'user',userId:'1',token:'fake'});configure({syncMaxRequests:8,syncMaxMessages:3});
    let requests=0;
    globalThis.fetch=(async(input:RequestInfo|URL)=>{
      requests++;const url=new URL(String(input));
      if(url.pathname.endsWith('/channels/200'))return Response.json({id:'200',type:0,name:'general',guild_id:'100'});
      if(url.pathname.endsWith('/guilds/100'))return Response.json({id:'100',name:'Community'});
      if(url.pathname.endsWith('/guilds/100/messages/search'))return Response.json({messages:[]});
      if(url.pathname.endsWith('/channels/200/messages'))return Response.json([
        {id:'2000',channel_id:'200',type:0,timestamp:new Date(T0).toISOString(),content:'My post',author:{id:'1',username:'Me'}}]);
      throw new Error(`Unexpected route ${url.pathname}`);
    }) as typeof fetch;
    const result=await sync(sdk);
    expect(requests).toBeLessThanOrEqual(8);expect(count('discord_messages')).toBe(1);expect(result!.indexed.indexed).toBe(1);
    expect(sdk.state.get('rest:channel:200')).toBe('2000');expect(sdk.state.getJson('relevance:last')).toMatchObject({accepted:1});
  });

  test('context jobs persist retry state and do not advance on rate limits',async()=>{
    sdk.credentials.set({kind:'user',userId:'1',token:'fake'});
    const connector=ingest([message('150',0,'I am here','1')]),state=(connector.policy as DiscordRelevancePolicy).state;
    globalThis.fetch=(async()=>Response.json({message:'rate limited',retry_after:5},{status:429})) as unknown as typeof fetch;
    const api=new DiscordAPI('fake','user',{requests:5,messages:500,deadline:Date.now()+10000});
    await expect(backfillDiscord(api,sdk,connector,sdk.settings.getAll(),state,'1')).rejects.toMatchObject({status:429});
    const job=db.query<{cursor:string|null;retry_at:number;fetched:number},[]>("SELECT cursor,retry_at,fetched FROM discord_promotions").get()!;
    expect(job.cursor).toBeNull();expect(job.fetched).toBe(0);expect(job.retry_at).toBeGreaterThan(Date.now());
  });

  test('repeated exclusion and reinstatement restores live graph assertions',async()=>{
    ingest([message('170',0,'My own discussion','1')]);await run(sdk);
    const first=db.query<{id:string},[]>("SELECT id FROM sources").get()!.id;
    configure({excludedConversations:['200']});await run(sdk);expect(count('sources')).toBe(0);
    configure({excludedConversations:[]});await run(sdk);
    expect(db.query<{id:string},[]>("SELECT id FROM sources").get()!.id).toBe(first);
    expect(getGraphData(sdk).nodes.some(node=>node.name==='Me')).toBe(true);
    expect(db.query<{n:number},[]>("SELECT count(*) AS n FROM graph_claims WHERE status='accepted'").get()!.n).toBeGreaterThan(0);
  });

  test('preserves a manually curated source and its refresh mapping',async()=>{
    ingest([message('180',0,'My discussion','1')]);await run(sdk);
    const source=db.query<{id:string},[]>("SELECT id FROM sources").get()!.id;
    await sdk.knowledge.apply({actor:'user',reason:'Curate my source',operations:[{type:'update_source',args:{sourceId:source,title:'My curated source'}}]});
    configure({excludedConversations:['200']});await run(sdk);
    expect(sdk.context.getSource(source)?.title).toBe('My curated source');
    expect(discordConnector(sdk).store.windowBySource(source)).not.toBeNull();
  });

  test('bounds classification calls and leaves excess candidates pending',async()=>{
    configure({interests:['SQLite'],relevanceMaxLLMCalls:1});
    ingest([message('190',0,'SQLite migration context. '.repeat(8)),message('191',180,'SQLite transaction behavior. '.repeat(8))]);await run(sdk);
    expect(classificationCalls).toBe(1);
    expect(db.query<{n:number},[]>("SELECT count(*) AS n FROM discord_relevance WHERE status='pending'").get()!.n).toBe(1);
  });

  test('retrieves an old cross-channel reply target as related context',async()=>{
    const connector=ingest([message('3001',0,'Replying to the older question','1',{replyToId:'500',replyConversationId:'200'})],
      {...conversation,conversationId:'300',kind:'thread',parentId:'200',uri:'discord://channel/300'});
    const state=(connector.policy as DiscordRelevancePolicy).state;
    globalThis.fetch=(async(input:RequestInfo|URL)=>{
      const url=new URL(String(input));
      if(url.pathname.endsWith('/channels/300/messages/300'))return Response.json({message:'Deleted starter'},{status:404});
      if(url.pathname.endsWith('/channels/300/messages'))return Response.json([{id:'3001',channel_id:'300',type:19,
        timestamp:new Date(T0).toISOString(),content:'Replying to the older question',author:{id:'1',username:'Me'},
        message_reference:{message_id:'500',channel_id:'200'}}]);
      if(url.pathname.endsWith('/channels/200'))return Response.json({id:'200',type:0,name:'general'});
      if(url.pathname.endsWith('/channels/200/messages/500'))return Response.json({id:'500',channel_id:'200',type:0,
        timestamp:new Date(T0-365*86_400_000).toISOString(),content:'The original old project question. '.repeat(5),author:{id:'2',username:'Bob'}});
      throw new Error(`Unexpected route ${url.pathname}`);
    }) as typeof fetch;
    const api=new DiscordAPI('fake','user',{requests:10,messages:200,deadline:Date.now()+10000});
    await backfillDiscord(api,sdk,connector,sdk.settings.getAll(),state,'1');await run(sdk);
    expect(sdk.context.getSources({origin:'discord'})).toHaveLength(2);
    expect(connector.store.loadMessages('200',['500'])).toHaveLength(1);
    expect(db.query<{mode:string},[]>("SELECT mode FROM discord_coverage WHERE conversation_id='300'").get()!.mode).toBe('incomplete');
  });

  test('interest inference sees only sources allowed by its access profile',async()=>{
    const previousAccess=process.env.SHALE_ACCESS_PATH;
    const accessPath=join(directory,'access.json');process.env.SHALE_ACCESS_PATH=accessPath;
    writeFileSync(accessPath,JSON.stringify({defaultTier:'personal',unauthenticatedProfile:'local',originTiers:{public_notes:'public'},
      tierRules:[],profiles:{local:{clearance:'secret'},interest:{clearance:'public',write:false}}}));
    db.close();db=createTestDatabase(join(directory,'scoped.db'));
    sdk=createExtensionSDK('discord',{database:db,messageBus:createMessageBus(),extensionDir:directory});
    discordConnector(sdk);
    for(const [id,origin,text] of [['visible','public_notes','Visible SQLite interest'],['hidden','private_notes','HIDDEN_PRIVATE_PROJECT']])
      sdk.ingest.sourceAndChunks({source:{id:id!,uri:`note://${id}`,origin:origin!,type:'note',title:text!},chunks:[{chunk_index:0,chunk_type:'verbatim',text_content:text!}]});
    const owner=sdk.graph.entities.create({name:'Owner',type:'Person'}),goal=sdk.graph.entities.create({name:'Public ML research goal',type:'CareerInterest'});
    sdk.graph.claims.add({id:'visible-goal',namespace:'conversation-analysis',subject:owner.id,predicate:'PRIORITIZES',object:goal.id,status:'accepted'});
    ensureAccessSchema(db);
    setLabel(db,'entity',String(owner.id),'manual',0);setLabel(db,'entity',String(goal.id),'manual',0);
    setLabel(db,'claim','visible-goal','manual',0);
    let sent='';sdk.queryLLM=(async(prompt:string)=>{sent=prompt;return JSON.stringify({topics:['SQLite']});}) as typeof sdk.queryLLM;
    configure({interestProfile:'interest'});
    try {
      await refreshInterests(sdk,sdk.settings.getAll(),Date.now()+10000);
      expect(sent).toContain('Visible SQLite interest');expect(sent).not.toContain('HIDDEN_PRIVATE_PROJECT');
      expect(sent).toContain('Public ML research goal');
      expect(sdk.state.getJson<{topics:string[]}>('relevance:interests')!.topics).toContain('Public ML research goal');
    } finally {
      closeScopedSDKs();if(previousAccess===undefined)delete process.env.SHALE_ACCESS_PATH;else process.env.SHALE_ACCESS_PATH=previousAccess;
    }
  });

  test('applies new exclusions to retained sources after their raw history has expired',async()=>{
    configure({rawRetentionDays:1});ingest([message('210',0,'My archived discussion','1')]);await run(sdk);
    expect(count('sources')).toBe(1);expect(count('discord_messages')).toBe(0);
    configure({excludedConversations:['200']});await run(sdk);
    expect(count('sources')).toBe(0);expect(getGraphData(sdk).nodes).toHaveLength(0);
  });

  test('removes excluded contributors from an accepted source after raw eviction',async()=>{
    configure({rawRetentionDays:1});ingest([message('220',0,'My discussion','1'),message('221',1,'A substantive related answer. '.repeat(6))]);await run(sdk);
    expect(count('discord_messages')).toBe(0);expect(sdk.graph.entities.resolve('Bob')).toHaveLength(1);
    configure({excludedPeople:['2']});await run(sdk);
    expect(count('sources')).toBe(1);expect(sdk.graph.entities.resolve('Bob')).toHaveLength(0);
    expect(getGraphData(sdk).nodes.some(node=>node.name==='Me')).toBe(true);
  });

  test('retired identities retain exclusive ownership of their Discord IDs',async()=>{
    configure({relevanceEnabled:false});ingest([message('230',0,'A public discussion. '.repeat(8))]);await run(sdk);
    configure({relevanceEnabled:true});await run(sdk);expect(sdk.graph.entities.resolve('Bob')).toHaveLength(0);
    expect(()=>sdk.graph.entities.create({name:'Different person',type:'Person',externalIds:{discord:'2'}}))
      .toThrow('External identifier already belongs');
  });

  test('replaces a singleton source at the boundary of backfilled history without leaving graph clutter',async()=>{
    configure({includedPeople:['2']});ingest([message('250',0,'The older discussion. '.repeat(8))]);await run(sdk);
    ingest([message('249',-1,'My earlier participation','1')]);await run(sdk);
    expect(count('sources')).toBe(1);
    expect(getGraphData(sdk).nodes.filter(node=>node.type==='ChatSession')).toHaveLength(1);
    expect(db.query<{n:number},[]>("SELECT count(*) AS n FROM graph_events g JOIN graph_claims c ON c.id=g.claim_id WHERE c.status='accepted'").get()!.n).toBe(1);
  });
});
