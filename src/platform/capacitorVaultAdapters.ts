import { registerPlugin } from '@capacitor/core';
import type {
  BackupExporter,
  CreativeStorage,
  CreativeWorkspaceState,
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
  saveStory(options: { story: Story; expectedUpdatedAt?: number }): Promise<void>;
  deleteStory(options: { id: string }): Promise<void>;
  getActiveStoryId(): Promise<{ id: string | null; present: boolean }>;
  setActiveStoryId(options: { id: string | null }): Promise<void>;
  exportJsonFile(options: { fileName: string; jsonContent: string; format?: 'markdown' | 'attachment' }): Promise<void>;
  loadCreativeWorkspace?(): Promise<{ workspace: CreativeWorkspaceState | null }>;
  saveCreativeWorkspace?(options: { workspace: CreativeWorkspaceState; expected: number }): Promise<void>;
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
    saveStory(story: Story, expectedUpdatedAt?: number): Promise<void> {
      return enqueue(() => plugin.saveStory({ story, ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}) }));
    },
    deleteStory(id: string): Promise<void> {
      return enqueue(() => plugin.deleteStory({ id }));
    },
    getActiveStorySelection() {
      return enqueue(async () => {
        const selection = await plugin.getActiveStoryId();
        return selection.present
          ? { status: 'present' as const, id: selection.id }
          : { status: 'missing' as const };
      });
    },
    setActiveStoryId(id: string | null): Promise<void> {
      return enqueue(() => plugin.setActiveStoryId({ id }));
    },
    compareAndSetActiveStoryId(expected: string | null, next: string | null): Promise<boolean> {
      return enqueue(async () => {
        const selection = await plugin.getActiveStoryId();
        const current = selection.present ? selection.id : null;
        if (current !== expected) return false;
        await plugin.setActiveStoryId({ id: next });
        return true;
      });
    },
  };
}

/**
 * Bridges BackupExporter to Android FileProvider + native share/save sheet.
 * Diagnostic logs (`folio-logs-*`) use the same bridge and trigger the native share sheet ("分享排障日志").
 */
export function createAndroidBackupExporter(
  plugin: NativeVaultPluginLike = NativeVault,
): BackupExporter {
  return {
    async exportJsonFile(fileName: string, jsonContent: string): Promise<void> {
      await plugin.exportJsonFile({ fileName, jsonContent });
    },
    async exportMarkdown(fileName, markdown) {
      await plugin.exportJsonFile({ fileName, jsonContent: markdown, format: 'markdown' });
    },
    async exportAttachment(fileName, base64) {
      await plugin.exportJsonFile({ fileName, jsonContent: base64, format: 'attachment' });
    },
  };
}

export function createAndroidCreativeStorage(plugin: NativeVaultPluginLike = NativeVault): CreativeStorage {
  return {
    async load() {
      if (!plugin.loadCreativeWorkspace) throw new Error('当前 Android 客户端无法读取工作台。');
      return (await plugin.loadCreativeWorkspace()).workspace;
    },
    async save(workspace, expected) {
      if (!plugin.saveCreativeWorkspace) throw new Error('当前 Android 客户端无法保存工作台。');
      await plugin.saveCreativeWorkspace({ workspace, expected });
    },
  };
}
