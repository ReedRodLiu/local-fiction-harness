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

export const EXPECTED_RELEASE_CERT_SHA256: string;

export interface AuditApkSigningCertificateOptions {
  apkPath: string;
  runCommand?: (command: string, args: string[]) => string;
  expectedSha256?: string;
}

export interface AuditReleaseArtifactsOptions {
  runCommand?: (command: string, args: string[]) => string;
  expectedSha256?: string;
}

export interface AuditReleaseArtifactsResult {
  apkPath: string;
  apkBytes: number;
  signed: boolean;
  signingCertSha256?: string;
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
export function auditApkSigningCertificate(
  options: AuditApkSigningCertificateOptions,
): {
  signed: boolean;
  sha256: string;
  subjectDn: string | null;
};
export function auditReleaseArtifacts(
  rootDir?: string,
  secretValues?: string[],
  options?: AuditReleaseArtifactsOptions,
): AuditReleaseArtifactsResult;
export function runRepoArtifactAudit(
  rootDir?: string,
  options?: RunRepoArtifactAuditOptions,
): {
  distAssetCount: number;
  syncedAssetCount: number;
  apkBytes: number;
  apkPath: string;
  release?: AuditReleaseArtifactsResult;
};
