/** Datatypes describe literal values, not entity targets. Drop contradictory model metadata. */
export function consistentDatatype<T extends { datatype?: string; value?: unknown }>(claim: T): T {
  if (claim.datatype && (claim.value === undefined ||
    (['string', 'number', 'boolean', 'object'].includes(claim.datatype) && typeof claim.value !== claim.datatype))) {
    const { datatype: _dropped, ...rest } = claim;
    return rest as T;
  }
  return claim;
}
