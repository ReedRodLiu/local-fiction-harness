import type { SpotlightTutorialStep } from './SpotlightTutorial.tsx';

export interface MainTutorialStepOptions {
  onConnectAction: () => void;
}

/** Build the 4-step Stage 1 spotlight walkthrough for the main screen. */
export function buildMainTutorialSteps({
  onConnectAction,
}: MainTutorialStepOptions): SpotlightTutorialStep[] {
  return [
    {
      id: 'main-welcome-library',
      targetGroups: [
        ['#turn-input', '[data-testid="stage-composer"] textarea'],
        [
          '[data-testid="library-drawer-trigger"]',
          '[data-testid="desktop-library-toggle"]',
          '[data-testid="desktop-library"]',
        ],
      ],
      title: '自然语言开局 & 三模式书架',
      description:
        '在下方输入框直接输入即可开启「文游 / 写故事 / 角色互动」；也可以通过左侧书架页签切换模式、新建或导入，对话中还能用自然语言按当前故事或角色派生新对话。',
    },
    {
      id: 'main-model-reasoning',
      targetGroups: [['[data-testid="composer-generation-controls"]']],
      title: '模型与思考强度',
      description:
        '随时切换日常轻量 Flash 与旗舰深度 Pro 模型，并调节「关闭 / 低 / 高 / 极限」四档思考强度；长对话还会自动压缩历史上下文，帮你省 Token。',
    },
    {
      id: 'main-narrative-presets',
      targetGroups: [['[data-testid="composer-narrative-preset-trigger"]']],
      title: '叙事预设与叙事连贯保护',
      description:
        '点击底部右侧书签按钮，可随时选择或导入自定义「叙事预设」，并开启「叙事连贯保护」——在遇到生成中断或误判时自动衔接续写。',
    },
    {
      id: 'main-connect-deepseek',
      targetGroups: [
        [
          '[data-testid="welcome-key-hint"]',
          '[data-testid="desktop-settings-open"]',
          '[data-testid="library-drawer-trigger"]',
          '[data-testid="desktop-library-toggle"]',
        ],
      ],
      title: '连接 DeepSeek 开始使用',
      description:
        'API Key 仅保存在本机设备中，直接请求 DeepSeek 官方接口；完成连接后即可立即开始游玩与创作。',
      extraAction: {
        label: '去连接 DeepSeek',
        testId: 'tutorial-connect-cta',
        onClick: onConnectAction,
      },
    },
  ];
}

/** Build the 4-step Stage 2 spotlight walkthrough for the Settings page. */
export function buildSettingsTutorialSteps(): SpotlightTutorialStep[] {
  return [
    {
      id: 'settings-connection',
      targetGroups: [['[data-testid="settings-connection-group"]']],
      title: '连接 DeepSeek 与余额查询',
      description:
        '在这里配置或更换本地 API Key、随时刷新查看 DeepSeek 账户余额，并设定全局默认模型与思考强度。',
    },
    {
      id: 'settings-usage-overview',
      targetGroups: [['[data-testid="settings-usage-overview"]']],
      title: '省 Token 与用量总览',
      description:
        '汇总所有文游、写故事与角色互动的历史实测用量，直观查看上下文压缩与缓存命中为你节省的 Token 与费用。',
    },
    {
      id: 'settings-narrative-presets',
      targetGroups: [['[data-testid="settings-narrative-presets-group"]']],
      title: '叙事预设管理',
      description:
        '支持三段槽位（head / mid / tail）精细编排与「叙事连贯保护」，并可导入 .md / .txt 或 SillyTavern 预设模板。',
    },
    {
      id: 'settings-backup-replay',
      targetGroups: [
        ['[data-testid="settings-backup-group"]'],
        ['[data-testid="replay-tutorial-btn"]'],
      ],
      title: '全量备份、排障与重看引导',
      description:
        '随时导出全量本地工作区备份（.folio.json）或脱敏排障日志；点击「重新查看引导教程」可随时重置并重看完整引导。',
    },
  ];
}
