import { useId, useMemo, useState } from 'react';
import { GitBranch, RotateCcw, Search, X } from 'lucide-react';
import {
  SPAN_STAGE_MAX_TURNS,
  formatTurnPreview,
  getActiveBranchNodes,
  getForkSiblingBranches,
  projectStoryTreeOverview,
  projectStoryTreeSpanSegments,
  projectStoryTreeSpine,
  queryStoryBranches,
  type ForkSiblingBranch,
  type NodeDiagnosticStatus,
  type Story,
  type StoryBranchSortBy,
  type StoryTreeSpanItem,
} from '../harness/index.ts';

export interface StoryTreeProps {
  story: Story;
  isBusy?: boolean;
  isRenameBusy?: boolean;
  onSwitchBranch?: (targetNodeId: string) => void;
  onRenameBranch?: (branchEntryNodeId: string, name: string) => Promise<void> | void;
  defaultExpanded?: boolean;
  collapsible?: boolean;
}

type StoryTreeTab = 'spine' | 'overview';

interface UndoSwitchState {
  storyId: string;
  previousLeafId: string;
  targetLabel: string;
}

const DIAGNOSTIC_LABELS: Record<NodeDiagnosticStatus, string> = {
  CONTENT_FILTER: '这条历史消息在原平台未完整生成',
  TIMEOUT: '这条历史消息生成时响应超时',
  INCOMPLETE: '这条历史消息未完整生成',
  REFUSAL: '本轮触发拒答，已从上下文隔离',
};

interface ExpandedSpanNode {
  id: string;
  turn: number;
}

export function formatDiagnosticTags(
  statuses: readonly NodeDiagnosticStatus[],
  hasContentRisk: boolean,
): string[] {
  const tags = statuses.map((s) => DIAGNOSTIC_LABELS[s] ?? s);
  if (hasContentRisk) {
    tags.push('原平台曾提示内容注意');
  }
  return tags;
}

export function StoryTree({
  story,
  isBusy = false,
  isRenameBusy,
  onSwitchBranch,
  onRenameBranch,
  defaultExpanded = true,
  collapsible = true,
}: StoryTreeProps) {
  const [isPanelOpen, setIsPanelOpen] = useState(defaultExpanded);
  const [activeTab, setActiveTab] = useState<StoryTreeTab>('spine');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<StoryBranchSortBy>('recent');
  const [expandedForkIds, setExpandedForkIds] = useState<Record<string, boolean>>({});
  const [expandedForkRetryIds, setExpandedForkRetryIds] = useState<Record<string, boolean>>({});
  const [expandedSpanNodes, setExpandedSpanNodes] = useState<Record<string, ExpandedSpanNode[]>>({});
  const [expandedLargeSpanIds, setExpandedLargeSpanIds] = useState<Record<string, boolean>>({});
  const [expandedSegmentIds, setExpandedSegmentIds] = useState<Record<string, boolean>>({});
  const [showOverviewRetries, setShowOverviewRetries] = useState(false);
  const [undoSwitch, setUndoSwitch] = useState<UndoSwitchState | null>(null);
  const [renamingEntryId, setRenamingEntryId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameBusy = isRenameBusy ?? isBusy;
  const treeOpen = !collapsible || isPanelOpen;
  const spanIdPrefix = useId();

  const spine = useMemo(() => projectStoryTreeSpine(story), [story]);
  const overview = useMemo(() => projectStoryTreeOverview(story), [story]);
  const activePath = useMemo(
    () => getActiveBranchNodes(story, spine.activeLeafNodeId),
    [story, spine.activeLeafNodeId],
  );
  const spanRefusalById = useMemo(() => {
    const indexById = new Map<string, number>();
    activePath.forEach((node, idx) => indexById.set(node.id, idx));
    const refusalMap = new Map<string, boolean>();
    for (const item of spine.items) {
      if (item.kind !== 'span') continue;
      const startIndex = indexById.get(item.startNodeId) ?? -1;
      const endIndex = indexById.get(item.endNodeId) ?? -1;
      let hasRefusal = false;
      if (startIndex >= 0 && endIndex >= startIndex) {
        for (let i = startIndex; i <= endIndex; i++) {
          if (activePath[i].diagnostics?.sourceStatus === 'REFUSAL') {
            hasRefusal = true;
            break;
          }
        }
      }
      refusalMap.set(item.id, hasRefusal);
    }
    return refusalMap;
  }, [activePath, spine]);
  const activeTurnByNodeId = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < activePath.length; i += 1) {
      map.set(activePath[i].id, Math.floor(i / 2) + 1);
    }
    return map;
  }, [activePath]);

  const isSearching = searchQuery.trim().length > 0;
  const showOverview = activeTab === 'overview' || isSearching;
  const activeUndo = undoSwitch && undoSwitch.storyId === story.id ? undoSwitch : null;

  const visibleEffectiveBranches = useMemo(
    () =>
      showOverview
        ? queryStoryBranches(overview, { query: searchQuery, sortBy, includeRetries: false })
        : [],
    [overview, searchQuery, showOverview, sortBy],
  );

  const visibleRetryBranches = useMemo(
    () =>
      showOverview
        ? queryStoryBranches(overview, { query: searchQuery, sortBy, includeRetries: true }).filter(
            (branch) => branch.isSingleTurnRetry,
          )
        : [],
    [overview, searchQuery, showOverview, sortBy],
  );

  const toggleFork = (forkId: string) => {
    setExpandedForkIds((prev) => ({ ...prev, [forkId]: !prev[forkId] }));
  };

  const toggleForkRetries = (forkId: string) => {
    setExpandedForkRetryIds((prev) => ({ ...prev, [forkId]: !prev[forkId] }));
  };

  const toggleSpan = (item: StoryTreeSpanItem) => {
    if (item.turnCount > SPAN_STAGE_MAX_TURNS) {
      setExpandedLargeSpanIds((prev) => ({ ...prev, [item.id]: !prev[item.id] }));
      return;
    }

    if (expandedSpanNodes[item.id]) {
      setExpandedSpanNodes((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      return;
    }

    const startIndex = activePath.findIndex((node) => node.id === item.startNodeId);
    const endIndex = activePath.findIndex((node) => node.id === item.endNodeId);
    if (startIndex < 0 || endIndex < startIndex) return;

    const nodes = activePath.slice(startIndex, endIndex + 1).map((node, offset) => ({
      id: node.id,
      turn: Math.floor((startIndex + offset) / 2) + 1,
    }));
    setExpandedSpanNodes((prev) => ({ ...prev, [item.id]: nodes }));
  };

  const toggleSegment = (segmentId: string) => {
    setExpandedSegmentIds((prev) => ({ ...prev, [segmentId]: !prev[segmentId] }));
  };

  const handleSwitchBranch = (targetNodeId: string, targetLabel: string) => {
    if (!onSwitchBranch) return;
    if (story.activeLeafNodeId && story.activeLeafNodeId !== targetNodeId) {
      setUndoSwitch({
        storyId: story.id,
        previousLeafId: story.activeLeafNodeId,
        targetLabel,
      });
    }
    onSwitchBranch(targetNodeId);
  };

  const handleUndoSwitch = () => {
    if (!onSwitchBranch || !activeUndo) return;
    const previousLeafId = activeUndo.previousLeafId;
    setUndoSwitch(null);
    onSwitchBranch(previousLeafId);
  };

  const startRename = (branch: ForkSiblingBranch, useShortTitle = false) => {
    setRenamingEntryId(branch.entryNodeId);
    setRenameDraft(branch.customName ?? (useShortTitle ? branch.shortTitle : branch.label));
  };

  const commitRename = async (branchEntryNodeId: string) => {
    if (!onRenameBranch || renameBusy) return;
    await onRenameBranch(branchEntryNodeId, renameDraft);
    setRenamingEntryId(null);
    setRenameDraft('');
  };

  const renderSpanNodesList = (
    previewId: string | undefined,
    turnLabel: string,
    nodes: readonly ExpandedSpanNode[],
  ) => (
    <ol
      id={previewId}
      className="story-tree-span-nodes"
      aria-label={`${turnLabel}连续节点只读预览`}
      data-testid="story-tree-span-preview"
    >
      {nodes.map(({ id, turn }) => {
        const node = story.nodes[id];
        if (!node) return null;
        const diagnostics = formatDiagnosticTags(
          node.diagnostics?.sourceStatus ? [node.diagnostics.sourceStatus] : [],
          Boolean(node.diagnostics?.contentRisk),
        );
        return (
          <li
            key={id}
            className="story-tree-span-node"
            data-node-id={id}
            data-testid="story-tree-span-node"
          >
            <span className="story-tree-span-node-heading">
              第 {turn} 轮 · {node.role === 'user' ? '玩家' : '叙事 AI'}
            </span>
            <p
              className={`story-tree-span-node-preview ${node.role === 'user' ? 'is-user' : 'is-assistant'}`}
            >
              {formatTurnPreview(node)}
            </p>
            {diagnostics.length > 0 && (
              <span className="story-tree-span-node-diagnostics" role="note">
                来源提示：{diagnostics.join(' · ')}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );

  const renderBranchCard = (
    branch: ForkSiblingBranch,
    mode: 'spine' | 'overview',
  ) => {
    const diagTags = formatDiagnosticTags(branch.diagnostics, branch.hasContentRisk);
    const isRenaming = renamingEntryId === branch.entryNodeId;
    const displayTitle = mode === 'overview' ? branch.shortTitle : branch.label;
    const forkOriginLabel =
      branch.forkAfterTurn === 0 ? '开局分支' : `自第 ${branch.forkAfterTurn} 轮分叉`;

    return (
      <li
        key={branch.entryNodeId}
        className={`story-tree-sibling story-tree-fork-card ${branch.isActive ? 'active is-active' : ''}`}
        data-testid={
          mode === 'overview'
            ? `story-tree-overview-branch-${branch.entryNodeId}`
            : `story-tree-branch-${branch.entryNodeId}`
        }
        data-active={branch.isActive ? 'true' : 'false'}
      >
        <div className="story-tree-row-top">
          <strong>{displayTitle}</strong>
          {branch.isActive && <span className="badge badge-structure">当前路线</span>}
          <span className="status-text">
            支线 {branch.branchTurnCount} 轮（总 {branch.totalTurnDepth} 轮）
          </span>
          {branch.subBranchCount > 0 && (
            <span className="badge">{branch.subBranchCount} 子分支</span>
          )}
        </div>

        <div className="story-tree-card-meta">
          <span className="status-text">创建于 {branch.createdAtLabel}</span>
          {mode === 'overview' && <span className="status-text">{forkOriginLabel}</span>}
        </div>

        {branch.cues.length > 0 && (
          <div className="story-tree-cues">
            {branch.cues.map((cue) => (
              <span key={cue} className="cue-chip">
                {cue}
              </span>
            ))}
          </div>
        )}

        <div
          className={`story-tree-preview ${branch.leafRole === 'user' ? 'is-user' : 'is-assistant'}`}
        >
          {branch.preview}
        </div>

        {diagTags.length > 0 && (
          <div
            className="story-tree-diagnostics"
            role="note"
            data-testid={branch.diagnostics.includes('REFUSAL') ? 'story-tree-diag-refusal' : undefined}
          >
            来源提示：{diagTags.join(' · ')}
          </div>
        )}

        {isRenaming ? (
          <div className="rename-row story-tree-card-actions">
            <input
              type="text"
              aria-label="分支名称"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.nativeEvent.isComposing &&
                  e.nativeEvent.keyCode !== 229
                ) {
                  e.preventDefault();
                  void commitRename(branch.entryNodeId);
                }
              }}
            />
            <button
              type="button"
              className="btn btn-sm btn-primary"
              data-testid="story-tree-action"
              disabled={renameBusy}
              onClick={() => void commitRename(branch.entryNodeId)}
            >
              保存名称
            </button>
            <button
              type="button"
              className="btn btn-sm"
              data-testid="story-tree-action"
              onClick={() => setRenamingEntryId(null)}
            >
              取消
            </button>
          </div>
        ) : (
          <div className="btn-group story-tree-card-actions">
            {!branch.isActive && onSwitchBranch && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                data-testid="story-tree-action"
                disabled={isBusy}
                onClick={() => handleSwitchBranch(branch.entryNodeId, displayTitle)}
              >
                切换至此分支
              </button>
            )}
            {onRenameBranch && (
              <button
                type="button"
                className="btn btn-sm"
                data-testid="story-tree-action"
                disabled={renameBusy}
                onClick={() => startRename(branch, mode === 'overview')}
              >
                重命名
              </button>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="story-tree-panel" data-testid="story-tree-panel" aria-label="剧情树">
      <div className="panel-header">
        <div className="story-tree-heading">
          <h4>剧情树</h4>
          <span className="status-text">
            主干 {spine.totalActiveTurns} 轮 · {spine.forkCount} 处分叉
          </span>
        </div>
        {collapsible && (
          <button
            type="button"
            className="btn btn-sm"
            data-testid="story-tree-action"
            aria-expanded={isPanelOpen}
            onClick={() => setIsPanelOpen((prev) => !prev)}
          >
            {isPanelOpen ? '收起剧情树' : '展开剧情树'}
          </button>
        )}
      </div>

      {treeOpen && (
        <div className="story-tree-body">
          {activeUndo && (
            <div
              className="story-tree-undo-banner"
              data-testid="story-tree-undo-banner"
              role="status"
            >
              <span className="story-tree-undo-text">已切换至「{activeUndo.targetLabel}」</span>
              <button
                type="button"
                className="btn btn-sm story-tree-undo-btn"
                data-testid="story-tree-undo-switch"
                disabled={isBusy}
                onClick={handleUndoSwitch}
              >
                <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>撤销切换</span>
              </button>
            </div>
          )}

          {Object.keys(story.nodes).length > 0 && (
            <div className="story-tree-controls">
              <div
                className="companion-tabs companion-tabs-two story-tree-tabs"
                role="group"
                aria-label="剧情树视图"
              >
                <button
                  type="button"
                  className="companion-tab story-tree-tab"
                  data-testid="story-tree-tab-spine"
                  aria-pressed={!showOverview}
                  onClick={() => {
                    setActiveTab('spine');
                    setSearchQuery('');
                  }}
                >
                  当前脉络
                </button>
                <button
                  type="button"
                  className="companion-tab story-tree-tab"
                  data-testid="story-tree-tab-overview"
                  aria-pressed={showOverview}
                  onClick={() => setActiveTab('overview')}
                >
                  分支总览 ({overview.totalEffectiveBranches})
                </button>
              </div>

              <div className="story-tree-search-wrap">
                <Search
                  size={16}
                  strokeWidth={1.75}
                  className="story-tree-search-icon"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  className="story-tree-search-input"
                  data-testid="story-tree-search"
                  aria-label="搜索分支"
                  placeholder="搜索标题、线索或分叉轮次"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {isSearching && (
                  <button
                    type="button"
                    className="story-tree-search-clear"
                    aria-label="清除搜索"
                    onClick={() => setSearchQuery('')}
                  >
                    <X size={16} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          )}

          {Object.keys(story.nodes).length === 0 ? (
            <p className="status-text story-tree-empty">
              尚无对话节点，发送第一轮行动即可生成剧情树。
            </p>
          ) : showOverview ? (
            <div className="story-tree-overview" data-testid="story-tree-overview">
              <div className="story-tree-sort-bar" role="group" aria-label="分支排序">
                <button
                  type="button"
                  className={`btn btn-sm story-tree-sort-btn ${sortBy === 'recent' ? 'is-selected' : ''}`}
                  data-testid="story-tree-sort-recent"
                  aria-pressed={sortBy === 'recent'}
                  onClick={() => setSortBy('recent')}
                >
                  最近游玩
                </button>
                <button
                  type="button"
                  className={`btn btn-sm story-tree-sort-btn ${sortBy === 'scale' ? 'is-selected' : ''}`}
                  data-testid="story-tree-sort-scale"
                  aria-pressed={sortBy === 'scale'}
                  onClick={() => setSortBy('scale')}
                >
                  最多轮次
                </button>
              </div>

              {visibleEffectiveBranches.length === 0 && visibleRetryBranches.length === 0 ? (
                <p className="status-text story-tree-empty">
                  {isSearching ? '没有匹配的分支，请更换关键词。' : '尚无分支记录。'}
                </p>
              ) : (
                <>
                  {visibleEffectiveBranches.length > 0 && (
                    <ul className="story-tree-overview-list" aria-label="分支总览列表">
                      {visibleEffectiveBranches.map((branch) =>
                        renderBranchCard(branch, 'overview'),
                      )}
                    </ul>
                  )}

                  {visibleRetryBranches.length > 0 && (
                    <div className="story-tree-retries-section">
                      <button
                        type="button"
                        className="btn btn-sm story-tree-retries-toggle"
                        data-testid="story-tree-retries-toggle"
                        aria-expanded={showOverviewRetries}
                        onClick={() => setShowOverviewRetries((prev) => !prev)}
                      >
                        <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
                        <span>
                          {showOverviewRetries
                            ? `收起 ${visibleRetryBranches.length} 次单轮重试`
                            : `已收纳 ${visibleRetryBranches.length} 次单轮重试`}
                        </span>
                      </button>

                      {showOverviewRetries && (
                        <ul
                          className="story-tree-overview-list story-tree-retries-list"
                          aria-label="已收纳的单轮重试分支"
                        >
                          {visibleRetryBranches.map((branch) =>
                            renderBranchCard(branch, 'overview'),
                          )}
                        </ul>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <ol className="story-tree-spine">
              {spine.items.map((item, index) => {
                if (item.kind === 'span') {
                  const turnLabel =
                    item.startTurn === item.endTurn
                      ? `第 ${item.startTurn} 轮`
                      : `第 ${item.startTurn}–${item.endTurn} 轮`;
                  const isSegmented = item.turnCount > SPAN_STAGE_MAX_TURNS;
                  const expandedNodes = expandedSpanNodes[item.id];
                  const isExpanded = isSegmented
                    ? Boolean(expandedLargeSpanIds[item.id])
                    : expandedNodes !== undefined;
                  const previewId = `${spanIdPrefix}-span-${index}`;
                  const spanHasRefusal = spanRefusalById.get(item.id) ?? false;
                  const segments =
                    isSegmented && isExpanded
                      ? projectStoryTreeSpanSegments(story, item, SPAN_STAGE_MAX_TURNS)
                      : [];
                  return (
                    <li
                      key={item.id}
                      className={`story-tree-span story-tree-spine-item ${item.isActiveEnd ? 'active-end' : ''}`}
                      data-testid="story-tree-span"
                    >
                      <button
                        type="button"
                        className="story-tree-span-toggle"
                        aria-label={`${isExpanded ? '收起' : '展开'}${turnLabel}连续区间`}
                        aria-expanded={isExpanded}
                        aria-controls={isExpanded ? previewId : undefined}
                        data-testid="story-tree-span-toggle"
                        onClick={() => toggleSpan(item)}
                      >
                        <span className="badge" data-testid="story-tree-span-label">
                          {turnLabel}
                        </span>
                        <span className="status-text">
                          {isExpanded ? '收起连续区间' : '展开连续区间'}
                        </span>
                        <span className="status-text">
                          {item.isActiveEnd ? '当前激活终点' : `折叠 ${item.turnCount} 轮`}
                        </span>
                        {item.diagnosticsCount > 0 && (
                          <span className="badge badge-warn">
                            含 {item.diagnosticsCount} 条来源提示
                          </span>
                        )}
                        {spanHasRefusal && (
                          <span className="story-tree-refusal-note" data-testid="story-tree-diag-refusal">
                            本轮触发拒答，已从上下文隔离
                          </span>
                        )}
                        <span className="story-tree-preview-inline">{item.preview}</span>
                      </button>

                      {isSegmented && isExpanded && (
                        <ol
                          id={previewId}
                          className="story-tree-span-segments"
                          aria-label={`${turnLabel}分段区间`}
                          data-testid="story-tree-span-segments"
                        >
                          {segments.map((segment) => {
                            const segLabel =
                              segment.startTurn === segment.endTurn
                                ? `第 ${segment.startTurn} 轮`
                                : `第 ${segment.startTurn}–${segment.endTurn} 轮`;
                            const isSegExpanded = Boolean(expandedSegmentIds[segment.id]);
                            const segNodes: ExpandedSpanNode[] = isSegExpanded
                              ? segment.nodeIds.map((id, offset) => ({
                                  id,
                                  turn:
                                    activeTurnByNodeId.get(id) ??
                                    segment.startTurn + Math.floor(offset / 2),
                                }))
                              : [];

                            return (
                              <li key={segment.id} className="story-tree-span-segment">
                                <button
                                  type="button"
                                  className="story-tree-span-toggle story-tree-span-segment-toggle"
                                  data-testid="story-tree-span-segment-toggle"
                                  aria-expanded={isSegExpanded}
                                  onClick={() => toggleSegment(segment.id)}
                                >
                                  <span className="badge">{segLabel}</span>
                                  <span className="status-text">
                                    {isSegExpanded ? '收起分段' : '展开分段'}（{segment.turnCount} 轮）
                                  </span>
                                  {segment.diagnosticsCount > 0 && (
                                    <span className="badge badge-warn">
                                      含 {segment.diagnosticsCount} 条来源提示
                                    </span>
                                  )}
                                  <span className="story-tree-preview-inline">
                                    {segment.preview}
                                  </span>
                                </button>
                                {isSegExpanded &&
                                  renderSpanNodesList(undefined, segLabel, segNodes)}
                              </li>
                            );
                          })}
                        </ol>
                      )}

                      {!isSegmented &&
                        expandedNodes &&
                        renderSpanNodesList(previewId, turnLabel, expandedNodes)}
                    </li>
                  );
                }

                const isForkOpen = Boolean(expandedForkIds[item.id]);
                const siblings = isForkOpen ? getForkSiblingBranches(story, item.parentNodeId) : [];
                const visibleSiblings = siblings.filter((b) => !b.isSingleTurnRetry);
                const retrySiblings = siblings.filter((b) => b.isSingleTurnRetry);
                const isForkRetriesOpen = Boolean(expandedForkRetryIds[item.id]);

                return (
                  <li key={item.id} className="story-tree-fork-wrap story-tree-spine-item">
                    <button
                      type="button"
                      className="btn btn-sm story-tree-fork-btn"
                      data-testid={`story-tree-fork-${item.parentNodeId ?? 'root'}`}
                      aria-expanded={isForkOpen}
                      onClick={() => toggleFork(item.id)}
                    >
                      <span className="fork-badge">
                        <GitBranch size={14} strokeWidth={1.75} aria-hidden="true" />
                        <span>{item.branchCount} 条岔路</span>
                      </span>
                      <span>
                        {item.afterTurn === 0 ? '开局分叉' : `第 ${item.afterTurn} 轮分叉`} · 当前：
                        {item.activeBranchLabel}
                      </span>
                      <span className="status-text">{isForkOpen ? '收起旁支' : '展开旁支'}</span>
                    </button>

                    {isForkOpen && (
                      <ul
                        className="story-tree-siblings"
                        aria-label="分支列表"
                        data-testid="story-tree-branches"
                      >
                        {visibleSiblings.map((branch) => renderBranchCard(branch, 'spine'))}

                        {retrySiblings.length > 0 && (
                          <li className="story-tree-retries-group">
                            <button
                              type="button"
                              className="btn btn-sm story-tree-retries-toggle"
                              data-testid="story-tree-fork-retries-toggle"
                              aria-expanded={isForkRetriesOpen}
                              onClick={() => toggleForkRetries(item.id)}
                            >
                              <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
                              <span>
                                {isForkRetriesOpen
                                  ? `收起 ${retrySiblings.length} 次当轮重试`
                                  : `已收纳 ${retrySiblings.length} 次当轮重试`}
                              </span>
                            </button>

                            {isForkRetriesOpen && (
                              <ul
                                className="story-tree-siblings story-tree-retries-list"
                                aria-label="当轮重试分支"
                              >
                                {retrySiblings.map((branch) => renderBranchCard(branch, 'spine'))}
                              </ul>
                            )}
                          </li>
                        )}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
