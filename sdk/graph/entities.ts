import { randomUUIDv7 } from "bun";
import type { Database } from "bun:sqlite";
import type { EntityInput, GraphEntity } from "./types";
import { recordVersion } from '../knowledge/version';
import { sameFamily } from '../../lib/graph/ontology';

export class GraphEntities {
  constructor(private db: Database, private namespace: string) {}

  get(id: number): GraphEntity {
    const row = this.db.query<GraphEntity, [number]>(`SELECT id,stable_id AS stableId,namespace,
      coalesce(display_name,name) AS name,type,canonical_id AS canonicalId FROM entities WHERE id=?`).get(id);
    if (!row) throw new Error(`Unknown graph entity ${id}`);
    return {...row,version:recordVersion(this.db,'entity',id)};
  }

  canonical(id: number): GraphEntity {
    const seen = new Set<number>();
    let entity = this.get(id);
    while (entity.canonicalId !== null) {
      if (seen.has(entity.id)) throw new Error('Entity merge cycle');
      seen.add(entity.id);
      entity = this.get(entity.canonicalId);
    }
    return entity;
  }

  inspect(id: number) {
    return {entity:this.get(id),aliases:this.db.query<{alias:string;scope:string}, [number]>(
      'SELECT alias,scope FROM graph_aliases WHERE entity_id=? ORDER BY scope,alias').all(id),
      merges:this.db.query<{id:string;entity_id:number;canonical_id:number;reason:string;created_at:number;undone_at:number|null}, [number,number]>(
        'SELECT * FROM graph_identity_changes WHERE entity_id=? OR canonical_id=? ORDER BY created_at DESC').all(id,id)};
  }

  create(input: EntityInput): GraphEntity {
    if (!input.name.trim() || !input.type.trim()) throw new Error('Entity name and type are required');
    return this.db.transaction(() => {
      const stableId = input.stableId ?? randomUUIDv7();
      const existing = this.db.query<{id: number}, [string]>('SELECT id FROM entities WHERE stable_id=?').get(stableId);
      if (existing) {
        const entity = this.get(existing.id);
        if (entity.namespace !== (input.namespace ?? this.namespace) || entity.type !== input.type)
          throw new Error('Stable identity cannot change namespace or type');
        this.rename(entity.id, input.name);
      } else {
        this.db.query(`INSERT INTO entities(namespace,name,display_name,type,stable_id) VALUES(?,?,?,?,?)`)
          .run(input.namespace ?? this.namespace, `entity:${stableId}`, input.name, input.type, stableId);
      }
      const id = this.db.query<{id: number}, [string]>('SELECT id FROM entities WHERE stable_id=?').get(stableId)!.id;
      this.db.query('DELETE FROM graph_entity_retirements WHERE entity_id=?').run(id);
      this.addAlias(id, input.name);
      for (const alias of input.aliases ?? [])
        this.addAlias(id, typeof alias === 'string' ? alias : alias.name, typeof alias === 'string' ? '' : alias.scope);
      for (const [authority, externalId] of Object.entries(input.externalIds ?? {}))
        this.addAlias(id, externalId, `external:${authority}`);
      return this.get(id);
    })();
  }

  rename(id: number, name: string) {
    if (!name.trim()) throw new Error('Entity name is required');
    return this.db.transaction(() => {
      this.addAlias(id, this.get(id).name);
      this.db.query('UPDATE entities SET display_name=? WHERE id=?').run(name, id);
      this.addAlias(id, name);
      return this.get(id);
    })();
  }

  addAlias(id: number, name: string, scope = '') {
    this.get(id);
    if (!name.trim()) throw new Error('Alias is required');
    if (scope.startsWith('external:')) {
      // Retired identities still own their external IDs even though ordinary discovery omits them.
      const owners=this.db.query<{entity_id:number},[string,string]>(
        'SELECT entity_id FROM graph_aliases WHERE alias=? AND scope=?').all(name.trim(),scope);
      if(owners.some(owner=>this.canonical(owner.entity_id).id!==this.canonical(id).id))
        throw new Error('External identifier already belongs to another entity');
    }
    this.db.query('INSERT OR IGNORE INTO graph_aliases VALUES(?,?,?)').run(id, name.trim(), scope);
  }

  removeAlias(id: number, name: string, scope = '') {
    this.db.query('DELETE FROM graph_aliases WHERE entity_id=? AND alias=? AND scope=?').run(id, name, scope);
  }

  /** Ambiguous labels return all candidates; callers must choose explicitly. */
  resolve(name: string, scope = '', namespace?: string): GraphEntity[] {
    const ids = this.db.query<{id: number}, [string,string,string,string,string,string|null,string|null]>(`
      SELECT DISTINCT e.id FROM entities e LEFT JOIN graph_aliases a ON a.entity_id=e.id
      WHERE NOT EXISTS(SELECT 1 FROM graph_entity_retirements r WHERE r.entity_id=e.id)
      AND (e.stable_id=? OR (a.alias=? AND a.scope=?) OR (?='' AND coalesce(e.display_name,e.name)=?))
      AND (? IS NULL OR e.namespace=?) ORDER BY e.id`).all(name,name,scope,scope,name,namespace ?? null,namespace ?? null);
    return [...new Map(ids.map(row => { const entity = this.canonical(row.id); return [entity.id,entity]; })).values()];
  }

  merge(from: number, into: number, reason: string): string {
    if (!reason.trim()) throw new Error('Merge reason is required');
    return this.db.transaction(() => {
      const source = this.get(from);
      const target = this.canonical(into);
      if (source.canonicalId !== null || target.id === from) throw new Error('Invalid entity merge');
      if (!sameFamily(source.type, target.type)) throw new Error('Cannot merge entities with different types');
      const id = randomUUIDv7();
      this.db.query('INSERT INTO graph_identity_changes VALUES(?,?,?,?,?,NULL)').run(id,from,target.id,reason,Date.now());
      this.db.query('UPDATE entities SET canonical_id=? WHERE id=?').run(target.id,from);
      return id;
    })();
  }

  unmerge(changeId: string) {
    this.db.transaction(() => {
      const change = this.db.query<{entity_id:number;canonical_id:number}, [string]>(
        'SELECT entity_id,canonical_id FROM graph_identity_changes WHERE id=? AND undone_at IS NULL').get(changeId);
      if (!change || this.get(change.entity_id).canonicalId !== change.canonical_id) throw new Error('Merge is not active');
      this.db.query('UPDATE entities SET canonical_id=NULL WHERE id=?').run(change.entity_id);
      this.db.query('UPDATE graph_identity_changes SET undone_at=? WHERE id=?').run(Date.now(),changeId);
      // Episode narratives must be regenerated for the now-separate member groups.
      this.db.query('UPDATE graph_episodes SET updated_at=? WHERE entity_id IN (?,?)')
        .run(Date.now(), change.entity_id, change.canonical_id);
    })();
  }
}
