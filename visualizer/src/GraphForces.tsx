import { DEFAULT_FORCES, FORCE_CONTROLS, type GraphForces as Forces } from './graph-preferences';

export function GraphForces({ value, onChange }: { value: Forces; onChange: (forces: Forces) => void }) {
  return <details className="graph-forces">
    <summary>Forces</summary>
    <div className="graph-force-fields">
      {FORCE_CONTROLS.map(({ key, label, min, max, step }) => <label key={key}>
        <span>{label}<output>{value[key]}</output></span>
        <input aria-label={label} type="range" min={min} max={max} step={step} value={value[key]} onChange={event => onChange({ ...value, [key]: Number(event.target.value) })} />
      </label>)}
      <button type="button" onClick={() => onChange({ ...DEFAULT_FORCES })}>Restore defaults</button>
    </div>
  </details>;
}
