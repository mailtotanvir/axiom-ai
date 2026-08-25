/**
 * Template rendering (O2). Variables are validated against the version's
 * JSON Schema with ajv before {{var}} substitution, so a malformed render
 * never reaches a model.
 */

// Named import: this package is ESM ("type": module), so NodeNext types
// ajv's default binding as a non-constructable module namespace.
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";

const ajv = new Ajv({ allErrors: true });
const compiled = new Map<string, ValidateFunction>();

function validatorFor(schemaKey: string, schema: Record<string, unknown>): ValidateFunction {
  const cached = compiled.get(schemaKey);
  if (cached !== undefined) {
    return cached;
  }
  const validate = ajv.compile(schema);
  compiled.set(schemaKey, validate);
  return validate;
}

export interface RenderResult {
  ok: boolean;
  rendered?: string;
  errors?: Array<{ path: string; message: string }>;
}

export function extractVariables(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)) {
    names.add(match[1]!);
  }
  return [...names];
}

export function renderTemplate(
  schemaKey: string,
  template: string,
  vars: Record<string, unknown>,
  schema?: Record<string, unknown> | null,
): RenderResult {
  if (schema !== undefined && schema !== null) {
    const validate = validatorFor(schemaKey, schema);
    if (!validate(vars)) {
      return {
        ok: false,
        errors: (validate.errors ?? []).map((error) => ({
          path: error.instancePath || "/",
          message: error.message ?? "invalid value",
        })),
      };
    }
  }

  const missing: string[] = [];
  const rendered = template.replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
    (_whole: string, name: string) => {
      if (!(name in vars)) {
        missing.push(name);
        return _whole;
      }
      const value = vars[name];
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  );
  if (missing.length > 0) {
    return {
      ok: false,
      errors: missing.map((name) => ({
        path: `/${name}`,
        message: "template variable has no value",
      })),
    };
  }
  return { ok: true, rendered };
}
