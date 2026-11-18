export interface AuditTextAsset {
  path: string;
  content: string;
}

export function extractEnvSecretValues(envText: string): string[];
export function auditManifestXml(xmlText: string): void;
export function auditTextAssets(files: AuditTextAsset[], secretValues?: string[]): void;
export function auditApkArchive(apkBytes: Uint8Array, secretValues?: string[]): void;
export function runRepoArtifactAudit(rootDir?: string): {
  distAssetCount: number;
  syncedAssetCount: number;
  apkBytes: number;
  apkPath: string;
};
