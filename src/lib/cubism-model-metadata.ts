export interface CubismParameterMetadata {
  id: string;
  value: number;
  minimum: number;
  maximum: number;
  defaultValue: number;
}
export interface CubismPartMetadata {
  id: string;
  opacity: number;
}
export interface CubismModelMetadata {
  schema: "haneoka-cubism-model-metadata-v1";
  coreSha256: string;
  producerSha256: string;
  mocSha256: string;
  coreVersion: number;
  parameters: CubismParameterMetadata[];
  parts: CubismPartMetadata[];
}
