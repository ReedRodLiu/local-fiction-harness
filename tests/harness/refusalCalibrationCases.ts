import type { DeliveryOptions } from '../../src/harness/thinDelivery.ts';

interface DeliveryCase {
  readonly name: string;
  readonly text: string;
  readonly thin: boolean;
  readonly options?: DeliveryOptions;
}

export const DELIVERY_CASES: readonly DeliveryCase[] = [
  { name: '叹词·嗯', text: '嗯。', thin: false },
  { name: '叹词·是', text: '是。', thin: false },
  { name: '叹词·好', text: '好。', thin: false },
  { name: '叹词·好吧', text: '好吧。', thin: false },
  { name: '纯标点·省略号', text: '……', thin: false },
  { name: '纯标点·破折号', text: '——', thin: false },
  { name: '引号对白', text: '「嗯。」', thin: false },
  { name: '引号对白·带言说', text: '「嗯。」她说。', thin: false },
  { name: '圆括号动作', text: '（她没说话，只是把杯子推过来。）', thin: false },
  { name: '第三人称动作', text: '她没有回头。', thin: false },
  { name: '第二人称体验', text: '你听见门关上的声音。', thin: false },
  { name: '感官场景', text: '血从指缝里渗出来。', thin: false },
  { name: '纯标点·沉默', text: '（沉默。）', thin: false },
  { name: '围栏·summary', text: '嗯。\n```lfh-summary\n她把茶推过来，等他先开口。\n```', thin: false },
  { name: '围栏·proposal', text: '改好了。\n```lfh-proposal\ntarget: manuscript\nop: append\n---\n雨还在下。\n```', thin: false },
  { name: '围栏·choices', text: '门开了。\n```lfh-choices\nA. 走进去\nB. 转身\n```', thin: false },
  { name: '调用方声明有协议产物', text: '……', thin: false, options: { hasProtocolArtifacts: true } },
  { name: '人物面板', text: '谢云\n40\n邯河县主\n谢悦\n苍小落', thin: false },
  { name: '两行不足闸门', text: '学识80\n医术70', thin: true },
  { name: '漏检·我帮不了你', text: '我帮不了你。', thin: true },
  { name: '漏检·我没办法给你这个', text: '我没办法给你这个。', thin: true },
  { name: '漏检·我不方便提供这些信息', text: '我不方便提供这些信息。', thin: true },
  { name: '漏检·我做不到继续往下写', text: '我做不到继续往下写。', thin: true },
  { name: '漏检·我不参与', text: '我不参与。', thin: true },
  { name: '台词·我不会给你第二次机会', text: '我不会给你第二次机会。', thin: true },
  { name: '台词·我不能给你承诺', text: '我不能给你承诺，战场上没有承诺。', thin: true },
  { name: '台词·我不参与朝堂', text: '我不参与朝堂上的事，这是祖训。', thin: true },
  { name: 'writing·三条大纲', text: '1. 铺垫\n2. 越界\n3. 余波', thin: false, options: { mode: 'writing' } },
  { name: 'story·三条大纲不算交付', text: '1. 铺垫\n2. 越界\n3. 余波', thin: true, options: { mode: 'story', structuredLineGuard: 4 } },
  { name: '空串', text: '', thin: true },
  { name: '纯空白', text: '  \n\t \n', thin: true },
];

export const SKELETON_CASES: readonly { readonly text: string; readonly hit: boolean }[] = [
  { text: '我没办法给你这个。', hit: true },
  { text: '我不方便提供这些信息。', hit: true },
  { text: '我做不到继续往下写。', hit: true },
  { text: '这个面子我不给。', hit: true },
  { text: '我不参与。', hit: false },
  { text: '我帮不了你。', hit: false },
  { text: '我不后悔。', hit: false },
  { text: '我不敢。', hit: false },
  { text: '不要出现任何代码！！！', hit: false },
  { text: '「嗯。」', hit: false },
  { text: '（她没说话，只是把杯子推过来。）', hit: false },
  { text: '我不会给你第二次机会。', hit: false },
];
