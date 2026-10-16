export interface KnowledgeExtractorSettings {
  enabled:boolean;maxSourcesPerRun:number;maxContentChars:number;namespace:string;llmModel:string|null;
  deterministicMode:'off'|'shadow'|'active';predicateSchema:'off'|'shadow'|'active';skipLlmWhenCovered:boolean;
  templateMode:'off'|'shadow'|'active';templateMinMembers:number;templateMinAlignment:number;maxTemplateLabelsPerRun:number;maxTemplateInductionsPerRun:number;
}
