import { SourceGraph, type ShaleSDK } from '@shale/sdk';
import type { PreparedSessionData } from './types';
import { sessionEntityName } from './identity';
import { buildSequentialEdges } from './navigation';

export function sessionObservationText(prepared: PreparedSessionData): string {
  return JSON.stringify({sessionId:prepared.sessionId,startTime:prepared.startTime,
    endTime:prepared.endTime,visits:prepared.visits},null,2);
}

export function commitSessionGraph(sdk: ShaleSDK, sourceId: string, prepared: PreparedSessionData,
  topics: string[], dominantDomains: string[]) {
  const {sessionId,startTime,endTime,visits,namespace,synthesis} = prepared;
  const graph = new SourceGraph(sdk.database,sdk.graph,sourceId,namespace,endTime);
  const context = sessionEntityName(sessionId);
  const session = graph.entity(context,synthesis.sessionTitle,'WebSession',context);
  const observed = {evidence:graph.evidence(1),context};
  graph.claim(session,'SOURCE_URI',{value:context},observed);
  const interpretation = {...observed,evidence:[...graph.evidence(1),...graph.evidence(0,undefined,'generated','mentions')],status:'proposed' as const,
    method:synthesis.method ?? 'llm',model:synthesis.model};
  graph.claim(session,'SUMMARY',{value:synthesis.summary},interpretation);
  for (const topic of topics) graph.link(session,'COVERS_TOPIC',graph.entity(topic.toLocaleLowerCase(),topic,'Topic',topic),interpretation);
  for (const domain of dominantDomains) graph.link(session,'PRIMARY_DOMAIN',graph.entity(domain,domain,'Domain',domain),interpretation);
  const pages = visits.map(visit => graph.entity(visit.url,visit.title,'WebPage',visit.url));
  const event = graph.event(`session:${sessionId}`,{name:synthesis.sessionTitle,kind:'browsing_session',
    context,occurredFrom:startTime,occurredTo:endTime,evidence:observed.evidence,
    participants:[{entity:session,role:'record'},...pages.map((entity,position)=>({entity,role:'page',position}))]});
  for (const [index,visit] of visits.entries()) {
    graph.link(session,'CONTAINS_PAGE',pages[index],{...observed,qualifiers:{visitOrder:index+1,
      visitedAt:visit.visitedAt,url:visit.url,transitionType:visit.transitionType ?? ''}});
    const occurrence = graph.event(`visit:${index}`,{name:`Visit ${index+1}: ${visit.title}`,kind:'page_visit',
      context,occurredFrom:visit.visitedAt,evidence:observed.evidence,
      participants:[{entity:pages[index],role:'page'},{entity:event,role:'session',position:index}]});
    for (const key of ['tabId','windowId','openerTabId','transitionType'] as const)
      if (visit[key] !== undefined) graph.claim(occurrence,key.toUpperCase(),{value:visit[key]!},observed);
  }
  for (const edge of buildSequentialEdges(visits)) graph.link(
    graph.entity(edge.source,edge.source,'WebPage',edge.source),'NAVIGATED_TO',
    graph.entity(edge.target,edge.target,'WebPage',edge.target),{...observed,qualifiers:edge.metadata});
  return graph;
}
