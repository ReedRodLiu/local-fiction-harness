import type {
  CreativeWorkspaceState,
  ModelConfig,
  PlatformRuntime,
  StageAssetMode,
} from '../harness/index.ts';
import { CharacterPane } from './CharacterPane.tsx';
import type { DocumentEdit } from './DocumentDialog.tsx';
import { DraftPane } from './DraftPane.tsx';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import type { RequestModel } from './useCreativeReply.ts';
import type { SaveWorkspace } from './useCreativeWorkspace.ts';

interface Props {
  mode: 'writing' | 'character';
  workspace: CreativeWorkspaceState;
  defaultConfig: ModelConfig;
  ready: boolean;
  storageError: string;
  save: SaveWorkspace;
  read: () => Promise<CreativeWorkspaceState>;
  runtime: PlatformRuntime;
  requestModel: RequestModel;
  openPublic: (proposal?: string, expected?: string) => void;
  openDocument: (edit: DocumentEdit) => void;
  manuscript?: boolean;
  onStartManuscript?: () => void;
  onSwitchToChat?: () => void;
  onSwitchStageMode?: (targetMode: StageAssetMode) => void;
  onNavigateCreatedAsset?: (kind: 'character' | 'work', id: string) => void;
  initialTurn: { id: string; prompt: string } | null;
  onConsumeInitialTurn: () => void;
  companionOpen: boolean;
  setCompanionOpen: (open: boolean) => void;
}

export function CreativeWorkspace(props: Props) {
  const { mode, workspace, ready, storageError } = props;
  const selectedWork = workspace.works.find((work) => work.id === workspace.activeWorkId);
  const selectedCharacter = workspace.characters.find((character) => character.id === workspace.activeCharacterId);
  const isWriting = mode === 'writing';

  return (
    <section className="creative-stage" data-testid={isWriting ? 'writing-page' : 'character-page'}>
      {storageError && <BannerAlert tone="danger">{storageError}</BannerAlert>}
      {ready && isWriting && selectedWork && <DraftPane key={selectedWork.id} {...props} work={selectedWork} />}
      {ready && !isWriting && selectedCharacter && (
        <CharacterPane key={selectedCharacter.id} {...props} character={selectedCharacter} />
      )}
    </section>
  );
}
