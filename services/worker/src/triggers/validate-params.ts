// A deliberately minimal JSON-Schema validator for create_automation's params check
// (trigger-abstraction spec, "Creation"): a chosen Trigger's paramsSchema validates the supplied
// params at create time, so an invalid email automation is rejected up front rather than silently
// degraded to fire-every-tick. No JSON-Schema library is in the workspace and agent-core stays
// framework-free, so this covers exactly the subset the built Triggers use — an `object` schema with
// typed `properties` (string | boolean | number) plus optional `required`. It is strict on the cases
// it does check (wrong type, unknown property, missing required) and tolerant of schema features it
// doesn't recognize (it never rejects a value a feature it can't read would have allowed). Returns an
// error string, or null when valid.

interface ObjectSchema {
  type?: string
  properties?: Record<string, { type?: string }>
  required?: string[]
  additionalProperties?: boolean
}

export function validateParams(schema: object, value: unknown): string | null {
  const s = schema as ObjectSchema
  // Only object schemas are checked; anything else (no Trigger uses one) passes through.
  if (s.type !== 'object') return null

  if (value == null) {
    // Absent params are allowed unless the schema names required keys.
    return (s.required && s.required.length > 0) ? `missing required params: ${s.required.join(', ')}` : null
  }
  if (typeof value !== 'object' || Array.isArray(value)) return 'params must be an object'

  const obj = value as Record<string, unknown>
  const props = s.properties ?? {}

  // Unknown property: reject unless the schema explicitly opts into additionalProperties. Catches a
  // typo'd param name (e.g. `sender` for `from`) the agent would otherwise pass silently.
  if (s.additionalProperties !== true) {
    for (const key of Object.keys(obj)) {
      if (!(key in props)) return `unknown param "${key}"`
    }
  }

  // Type-check each declared property that is present.
  for (const [key, spec] of Object.entries(props)) {
    if (!(key in obj) || obj[key] === undefined) continue
    const expected = spec.type
    if (!expected) continue
    const v = obj[key]
    const ok =
      expected === 'string'
        ? typeof v === 'string'
        : expected === 'boolean'
          ? typeof v === 'boolean'
          : expected === 'number' || expected === 'integer'
            ? typeof v === 'number'
            : true // unrecognized type keyword: don't reject
    if (!ok) return `param "${key}" must be a ${expected}`
  }

  // Required keys must be present.
  for (const key of s.required ?? []) {
    if (!(key in obj) || obj[key] === undefined) return `missing required param "${key}"`
  }

  return null
}
