import { registerPlugin } from '@capacitor/core';
import type {
  BackupExporter,
  ModelConfigMeta,
  SecretStore,
  Story,
  StoryStorage,
} from '../harness/index.ts';

export interface NativeVaultPluginLike {
  loadMeta(): Promise<{ meta: ModelConfigMeta | null }>;
  saveMeta(meta: ModelConfigMeta): Promise<void>;
  loadApiKey(): Promise<{ apiKey: string }>;
  saveApiKey(options: { apiKey: string }): Promise<void>;
  clearApiKey(): Promise<void>;
  listStories(): Promise<{ stories: Story[] }>;
  getStory(options: { id: string }): Promise<{ story: Story | null }>;
  saveStory(options: { story: Story }): Promise<void>;
  deleteStory(options: { id: string }): Promise<void>;
  getActiveStoryId(): Promise<{ id: string | null }>;
  setActiveStoryId(options: { id: string | null }): Promise<void>;
  exportJsonFile(options: { fileName: string; jsonContent: string }): Promise<void>;
}

const NativeVault = registerPlugin<NativeVaultPluginLike>('NativeVault');

/**
 * Bridges SecretStore to Android Keystore-encrypted native preferences.
 */
export function createAndroidSecretStore(
  plugin: NativeVaultPluginLike = NativeVault,
): SecretStore {
  return {
    async loadMeta(): Promise<ModelConfigMeta | null> {
      const res = await plugin.loadMeta();
      return res.meta ?? null;
    },
    async saveMeta(meta: ModelConfigMeta): Promise<void> {
      await plugin.saveMeta(meta);
    },
    async loadApiKey(): Promise<string> {
      const res = await plugin.loadApiKey();
      return res.apiKey ?? '';
    },
    async saveApiKey(apiKey: string): Promise<void> {
      await plugin.saveApiKey({ apiKey });
    },
    async clearApiKey(): Promise<void> {
      await plugin.clearApiKey();
    },
  };
}

/**
 * Bridges StoryStorage to Android app-private file storage with a sequential FIFO queue
 * so rapid UI actions never interleave or corrupt story writes.
 */
export function createAndroidStoryStorage(
  plugin: NativeVaultPluginLike = NativeVault,
): StoryStorage {
  let queue: Promise<void> = Promise.resolve();

  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const next = queue.then(op, op);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    listStories(): Promise<Story[]> {
      return enqueue(async () => (await plugin.listStories()).stories);
    },
    getStory(id: string): Promise<Story | null> {
      return enqueue(async () => (await plugin.getStory({ id })).story ?? null);
    },
    saveStory(story: Story): Promise<void> {
      return enqueue(() => plugin.saveStory({ story }));
    },
    deleteStory(id: string): Promise<void> {
      return enqueue(() => plugin.deleteStory({ id }));
    },
    getActiveStoryId(): Promise<string | null> {
      return enqueue(async () => (await plugin.getActiveStoryId()).id ?? null);
    },
    setActiveStoryId(id: string | null): Promise<void> {
      return enqueue(() => plugin.setActiveStoryId({ id }));
    },
  };
}

/**
 * Bridges BackupExporter to Android FileProvider + native share/save sheet.
 */
export function createAndroidBackupExporter(
  plugin: NativeVaultPluginLike = NativeVault,
): BackupExporter {
  return {
    async exportJsonFile(fileName: string, jsonContent: string): Promise<void> {
      await plugin.exportJsonFile({ fileName, jsonContent });
    },
  };
}
