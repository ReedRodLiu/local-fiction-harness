import type {
  BackupExporter,
  LlmTransport,
  PlatformRuntime,
  SecretStore,
  StoryStorage,
} from '../harness/index.ts';
import { createCapacitorSseTransport } from './capacitorSseTransport.ts';
import {
  createAndroidBackupExporter,
  createAndroidSecretStore,
  createAndroidStoryStorage,
} from './capacitorVaultAdapters.ts';

export interface AndroidRuntimeOptions {
  transport?: LlmTransport;
  storyStorage?: StoryStorage;
  secretStore?: SecretStore;
  backupExporter?: BackupExporter;
}

/**
 * Creates the Android PlatformRuntime adapter wired exclusively to native Capacitor bridges:
 * chunked SSE streaming, Keystore-encrypted SecretStore, app-private StoryStorage, and native BackupExporter.
 */
export function createAndroidPlatformRuntime(
  options: AndroidRuntimeOptions = {},
): PlatformRuntime {
  return {
    platform: 'android',
    transport: options.transport ?? createCapacitorSseTransport(),
    storyStorage: options.storyStorage ?? createAndroidStoryStorage(),
    secretStore: options.secretStore ?? createAndroidSecretStore(),
    backupExporter: options.backupExporter ?? createAndroidBackupExporter(),
    supportsMemoryOnlySession: true,
  };
}
