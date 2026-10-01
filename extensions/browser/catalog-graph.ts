import { SourceGraph, type ShaleSDK } from '@shale/sdk';

export interface CatalogRecord {
  title: string; sourceId: string; sourceUri: string; pageEntity: string;
  filter: {domain:string;cleanUrl:string};
  visitTime?: number; visitCount?: number; typedCount?: number;
  folder?: string; dateAdded?: number;
}

/** History counts are aggregates; bookmark records are distinct occurrences. */
export function commitCatalogGraph(sdk: ShaleSDK, record: CatalogRecord, namespace: string) {
  const graph = new SourceGraph(sdk.database,sdk.graph,record.sourceId,namespace,record.visitTime ?? record.dateAdded);
  const observed = {evidence:graph.evidence(0)};
  const page = graph.entity(record.pageEntity,record.title,'WebPage',record.pageEntity);
  graph.link(page,'BELONGS_TO_DOMAIN',graph.entity(record.filter.domain,record.filter.domain,'Domain',record.filter.domain),observed);
  const entity = graph.entity(record.sourceUri,record.title,record.folder === undefined ? 'HistoryRecord' : 'Bookmark');
  graph.claim(entity,'SOURCE_URI',{value:record.sourceUri},observed);
  graph.link(entity,'REFERS_TO',page,observed);
  if (record.folder !== undefined) {
    const folder = graph.entity(record.folder,record.folder,'BookmarkFolder',record.folder);
    graph.link(entity,'IN_FOLDER',folder,observed);
    graph.link(page,'BOOKMARKED_IN',folder,{...observed,qualifiers:{bookmark:record.sourceUri}});
    graph.claim(entity,'ADDED_AT',{value:record.dateAdded!},observed);
    graph.event('bookmark-added',{name:`Bookmarked ${record.title}`,kind:'bookmark_added',
      occurredFrom:record.dateAdded,evidence:observed.evidence,
      participants:[{entity,role:'bookmark'},{entity:page,role:'page'},{entity:folder,role:'folder'}]});
    const parts = record.folder.split('/').map(part=>part.trim()).filter(Boolean);
    for (let i=1;i<parts.length;i++) {
      const child = parts.slice(0,i+1).join('/'),parent=parts.slice(0,i).join('/');
      graph.link(graph.entity(child,child,'BookmarkFolder',child),'PART_OF',
        graph.entity(parent,parent,'BookmarkFolder',parent),observed);
    }
  } else {
    graph.claim(entity,'LAST_VISITED_AT',{value:record.visitTime!},observed);
    if (record.visitCount !== undefined) graph.claim(entity,'VISIT_COUNT',{value:record.visitCount},observed);
    if (record.typedCount !== undefined) graph.claim(entity,'TYPED_COUNT',{value:record.typedCount},observed);
    graph.event(`history:${record.visitTime}`,{name:`Last visit: ${record.title}`,kind:'history_observation',
      occurredFrom:record.visitTime,evidence:observed.evidence,
      participants:[{entity:page,role:'page'},{entity,role:'record'}]});
  }
  return graph;
}
