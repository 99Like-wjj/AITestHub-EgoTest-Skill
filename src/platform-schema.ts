import { z } from 'zod';
import snapshot from '../contracts/ba61508f-642a-49a6-b909-5cd81c4bde0e.json' with { type: 'json' };
import { invariant } from './errors.js';
import {
  withResultEvidence,
  resultEvidenceToolLeaves,
} from './result-evidence-contract.js';

const cache = new Map<string, z.ZodType>();
type SchemaNode = Record<string, unknown>;
function branches(raw: unknown, defs: SchemaNode): SchemaNode[] {
  invariant(
    raw !== null && typeof raw === 'object' && !Array.isArray(raw),
    'UNSUPPORTED_CONTRACT',
    'Expected a concrete tool input schema.',
  );
  let node = raw as SchemaNode;
  if (typeof node.$ref === 'string') {
    invariant(
      node.$ref.startsWith('#/$defs/') &&
        Object.keys(node).every((k) =>
          ['$ref', 'description', 'title'].includes(k),
        ),
      'UNSUPPORTED_CONTRACT',
      'Only local definition references are supported here.',
    );
    const key = node.$ref
      .slice('#/$defs/'.length)
      .replaceAll('~1', '/')
      .replaceAll('~0', '~');
    invariant(
      !key.includes('/') && defs[key],
      'UNSUPPORTED_CONTRACT',
      'Tool input reference cannot be resolved.',
    );
    return branches(defs[key], defs);
  }
  const union = node.anyOf ?? node.oneOf;
  if (union !== undefined) {
    invariant(
      Array.isArray(union) &&
        Object.keys(node).every((k) =>
          [
            '$schema',
            'type',
            'anyOf',
            'oneOf',
            '$defs',
            'description',
            'title',
          ].includes(k),
        ),
      'UNSUPPORTED_CONTRACT',
      'Unknown union wrapper; refuse to weaken structural validation.',
    );
    return union.flatMap((x) => branches(x, defs));
  }
  invariant(
    node.type === 'object' &&
      node.additionalProperties === false &&
      node.properties !== null &&
      typeof node.properties === 'object',
    'UNSUPPORTED_CONTRACT',
    'Tool input leaf must be a strict object.',
  );
  return [{ ...node, ...(Object.keys(defs).length ? { $defs: defs } : {}) }];
}
export function platformSchema(name: string): z.ZodType {
  const existing = cache.get(name);
  if (existing) return existing;
  const json = (snapshot.schemas as Record<string, unknown>)[name];
  invariant(
    json,
    'CONTRACT_NOT_AVAILABLE',
    'Required component is absent from the vendored platform snapshot.',
  );
  const enriched = withResultEvidence(
    json,
    ['domain.resultItemSchema', 'domain.resultSubmissionSchema'].includes(name)
      ? 1
      : 0,
  );
  const schema = z.fromJSONSchema(
    enriched as Parameters<typeof z.fromJSONSchema>[0],
  );
  cache.set(name, schema);
  return schema;
}
export function validateToolInput(name: string, value: unknown): void {
  const json = (snapshot.tools as Record<string, SchemaNode>)[name];
  invariant(
    json,
    'TOOL_NOT_AVAILABLE',
    'Tool is absent from this pinned platform snapshot.',
  );
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'INVALID_TOOL_INPUT',
    'Tool input must be an object.',
  );
  const op = (value as Record<string, unknown>).op;
  invariant(
    typeof op === 'string',
    'INVALID_TOOL_INPUT',
    'Tool op must be explicit.',
  );
  const key = `tool:${name}:${op}`;
  let schema = cache.get(key);
  if (!schema) {
    const definitions = (json.$defs ?? {}) as SchemaNode;
    const choices = branches(json, definitions).filter((branch) => {
      const property = (branch.properties as SchemaNode).op as
        SchemaNode | undefined;
      return (
        property?.const === op ||
        (Array.isArray(property?.enum) && property.enum.includes(op))
      );
    });
    invariant(
      choices.length > 0,
      'INVALID_TOOL_OP',
      'Tool op is not present in this contract artifact.',
    );
    const compiled = choices.map((x) =>
      z.fromJSONSchema(
        withResultEvidence(x, resultEvidenceToolLeaves(name, op)) as Parameters<
          typeof z.fromJSONSchema
        >[0],
      ),
    );
    schema =
      compiled.length === 1
        ? compiled[0]!
        : z.union(compiled as [z.ZodType, z.ZodType, ...z.ZodType[]]);
    cache.set(key, schema);
  }
  schema.parse(value);
}
export const contractArtifactId = snapshot.artifactId;
