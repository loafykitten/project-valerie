// Parameter schema builders shared by the tool definitions. Their output, including key
// order, is copied into pinned tool catalogs: changing one changes every offered schema.

export const textSchema = (maxLength: number, minLength = 1) => ({
  type: "string",
  minLength,
  maxLength,
});
export const versionSchema = { type: "integer", minimum: 1, maximum: 1000000 };
export const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
