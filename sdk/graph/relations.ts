import type { Database } from "bun:sqlite";
import type { ClaimInput, RelationDefinition } from "./types";
import type { GraphEntities } from "./entities";
import { serializeValue } from './values';

const BUILTINS: RelationDefinition[] = [
  ...['RELATES_TO','SIMILAR_TO','LINKED_TO','IN_SAME_VAULT','CONTRADICTS'].map(name => ({name,symmetric:true})),
  {name:'REFERENCES',inverse:'REFERENCED_BY'}, {name:'EXPANDS_UPON',inverse:'EXPANDED_BY'},
  {name:'SUPPORTS',inverse:'SUPPORTED_BY'}, {name:'PART_OF',inverse:'HAS_PART',transitive:true},
  {name:'DEPENDS_ON',inverse:'DEPENDENCY_OF'}, {name:'MENTIONS_ENTITY',inverse:'MENTIONED_BY'},
  {name:'COREFERS_TO',inverse:'HAS_ALIAS'},
  {name:'IN_VAULT',inverse:'HAS_SOURCE'}, {name:'CONTAINED_IN',inverse:'CONTAINS'},
  {name:'BELONGS_TO_DOMAIN',inverse:'HAS_PAGE'}, {name:'HAS_TOPIC',inverse:'TOPIC_OF'},
  {name:'HAS_TAG',inverse:'TAG_OF'}, {name:'FEATURES_IMAGE',inverse:'IMAGE_OF'},
  {name:'REFERS_TO',inverse:'REFERRED_BY'}, {name:'IN_FOLDER',inverse:'HAS_BOOKMARK'},
  {name:'BOOKMARKED_IN',inverse:'HAS_BOOKMARKED_PAGE'}, {name:'CONTAINS_PAGE',inverse:'IN_SESSION'},
];

export class GraphRelations {
  constructor(private db: Database, private entities: GraphEntities) {
    for (const definition of BUILTINS) {
      this.db.query('INSERT OR IGNORE INTO graph_relations VALUES(?,?)').run(definition.name,JSON.stringify(definition));
      if (definition.inverse) this.db.query('INSERT OR IGNORE INTO graph_relations VALUES(?,?)')
        .run(definition.inverse,JSON.stringify({name:definition.inverse,inverse:definition.name}));
    }
  }
  get(name: string): RelationDefinition | undefined {
    const row = this.db.query<{definition:string}, [string]>('SELECT definition FROM graph_relations WHERE name=?').get(name);
    return row ? JSON.parse(row.definition) : undefined;
  }
  define(definition: RelationDefinition) {
    if (!definition.name.trim() || (definition.symmetric && definition.inverse && definition.inverse !== definition.name))
      throw new Error('Invalid relationship definition');
    if (definition.maxTargets !== undefined && (!Number.isInteger(definition.maxTargets) || definition.maxTargets < 1))
      throw new Error('maxTargets must be a positive integer');
    this.db.transaction(() => {
      this.db.query('INSERT INTO graph_relations VALUES(?,?) ON CONFLICT(name) DO UPDATE SET definition=excluded.definition')
        .run(definition.name,JSON.stringify(definition));
      if (definition.inverse && !this.get(definition.inverse)) {
        this.define({name:definition.inverse,inverse:definition.name,
          sourceTypes:definition.targetTypes,targetTypes:definition.sourceTypes});
      }
    })();
  }
  reciprocal(name: string) {
    const definition = this.get(name);
    return definition?.symmetric ? name : definition?.inverse;
  }
  validate(input: ClaimInput) {
    const subject = this.entities.get(input.subject);
    const object = input.object === undefined ? undefined : this.entities.get(input.object);
    const definition = this.get(input.predicate);
    if (!input.predicate.trim()) throw new Error('Claim predicate is required');
    if (definition?.sourceTypes && !definition.sourceTypes.includes(subject.type)) throw new Error('Invalid relationship subject type');
    if (definition?.targetTypes && (!object || !definition.targetTypes.includes(object.type))) throw new Error('Invalid relationship object type');
    if (definition?.maxTargets && input.status === 'accepted' && input.polarity !== -1) {
      const rows = this.db.query<{object_id:number|null;value_json:string|null}, (string|number|null)[]>(`
        SELECT DISTINCT object_id,value_json FROM graph_claims WHERE subject_id=? AND predicate=? AND context=?
        AND namespace=? AND status='accepted' AND polarity=1 AND id IS NOT ?
        AND (? IS NULL OR valid_from IS NULL OR valid_from<?)
        AND (? IS NULL OR valid_to IS NULL OR valid_to>?)`).all(input.subject,input.predicate,input.context ?? '',input.namespace ?? '',input.id ?? null,
          input.validTo ?? null,input.validTo ?? null,input.validFrom ?? null,input.validFrom ?? null);
      const different = rows.filter(row => row.object_id !== (input.object ?? null) || row.value_json !== (input.object === undefined ? serializeValue(input.value!) : null));
      if (different.length >= definition.maxTargets) throw new Error('Relationship cardinality exceeded');
    }
  }
}
