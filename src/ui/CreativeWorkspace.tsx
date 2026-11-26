import type { RefObject } from 'react';
import type {
  CreativeWorkspaceState,
  ModelConfig,
  PlatformRuntime,
  PromptPackLibrary,
  StageAssetMode,
  Story,
} from '../harness/index.ts';
import { CharacterPane } from './CharacterPane.tsx';
import type { DocumentEdit } from './DocumentDialog.tsx';
import { DraftPane } from './DraftPane.tsx';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import type { CrossModeProposalConfirmPayload } from './proposalActions.ts';
import type { RequestModel } from './useCreativeReply.ts';
import type { SaveWorkspace } from './useCreativeWorkspace.ts';

interface Props {
  mode: 'writing' | 'character';
  workspace: CreativeWorkspaceState;
  defaultConfig?: ModelConfig;
  promptPackLibrary?: PromptPackLibrary;
  ready: boolean;
  storageError: string;
  save: SaveWorkspace;
  read: () => Promise<CreativeWorkspaceState>;
  runtime: PlatformRuntime;
  requestModel: RequestModel;
  openPublic: (proposal?: string, expected?: string) => void;
  openDocument: (edit: DocumentEdit) => void;
  onOpenNarrativePresets?: () => void;
  manuscript?: boolean;
  onStartManuscript?: () => void;
  onSwitchToChat?: () => void;
  onSaveDerivedStory?: (story: Story) => Promise<void>;
  onNavigateCreatedAsset?: (kind: 'character' | 'work' | 'story', id: string) => void;
  onRequestModeSwitch?: (
    input: string,
    fromMode: StageAssetMode,
    restoreInput: (text: string) => void,
  ) => boolean;
  onRequestCrossModeProposalConfirm?: (payload: CrossModeProposalConfirmPayload) => void;
  initialTurn: { id: string; prompt: string } | null;
  onConsumeInitialTurn: () => void;
  companionOpen: boolean;
  setCompanionOpen: (open: boolean) => void;
  scrollContainerRef?: RefObject<HTMLElement | null>;
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
