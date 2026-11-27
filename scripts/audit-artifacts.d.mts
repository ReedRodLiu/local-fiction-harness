export interface AuditTextAsset {
  path: string;
  content: string;
}

export interface AuditManifestOptions {
  packageId?: string;
  forbidDebuggable?: boolean;
  requireNetworkSecurityConfig?: boolean;
}

export interface AuditNetworkSecurityConfigOptions {
  forbidCleartext?: boolean;
  allowLoopbackOnly?: boolean;
}

export interface AuditCapacitorConfigOptions {
  forbidWebViewDebugging?: boolean;
  forbidRemoteServerUrl?: boolean;
}

export interface AuditApkArchiveOptions {
  packageId?: string;
  forbidDebuggable?: boolean;
  forbidCleartextNetworkConfig?: boolean;
  forbidWebViewDebugging?: boolean;
  forbidRemoteServerUrl?: boolean;
}

export interface RunRepoArtifactAuditOptions {
  requireRelease?: boolean;
}

export function extractEnvSecretValues(envText: string): string[];
export function auditManifestXml(xmlText: string, options?: AuditManifestOptions): void;
export function auditNetworkSecurityConfigXml(
  xmlText: string,
  options?: AuditNetworkSecurityConfigOptions,
): void;
export function auditCapacitorConfig(
  capConfig: Record<string, unknown>,
  options?: AuditCapacitorConfigOptions,
): void;
export function auditTextAssets(files: AuditTextAsset[], secretValues?: string[]): void;
export function auditApkArchive(
  apkBytes: Uint8Array,
  secretValues?: string[],
  options?: AuditApkArchiveOptions,
): void;
export function auditReleaseArtifacts(
  rootDir?: string,
  secretValues?: string[],
): {
  apkPath: string;
  apkBytes: number;
};
export function runRepoArtifactAudit(
  rootDir?: string,
  options?: RunRepoArtifactAuditOptions,
): {
  distAssetCount: number;
  syncedAssetCount: number;
  apkBytes: number;
  apkPath: string;
  release?: {
    apkPath: string;
    apkBytes: number;
  };
};
