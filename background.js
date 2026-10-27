import { captureIdentity, isClaudeUrl, sameTarget } from './lib/target.js';
import { claudeAdapter } from './content/claude-adapter.js';

chrome.action.onClicked.addListener(tab => {
  // Called immediately inside the browser user gesture.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
});

async function currentTarget(windowId) {
  if (!Number.isInteger(windowId)) throw new Error('请从 Chrome 工具栏打开侧栏。');
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab || !isClaudeUrl(tab.url) || tab.pendingUrl && tab.pendingUrl !== tab.url) {
    throw new Error('请打开 Claude 聊天页面，再点一次工具栏中的扩展图标。');
  }
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', func: captureIdentity
  });
  if (!frame?.result || frame.result.href !== tab.url) throw new Error('页面正在变化，请稍后再试。');
  return { tabId: tab.id, windowId, documentId: frame.documentId, ...frame.result };
}

async function handle(message) {
  if (message.type === 'TARGET') return { ok: true, target: await currentTarget(message.windowId) };
  if (!['PREPARE', 'COMMIT', 'CANCEL_FILL'].includes(message.type)) throw new Error('不支持的操作。');
  const expected = message.target;
  if (!expected || !isClaudeUrl(expected.href)) throw new Error('目标无效，请重新打开侧栏。');
  const actual = await currentTarget(expected.windowId);
  if (!sameTarget(expected, actual)) throw new Error('目标标签页或会话已变化，已停止填入。');
  if (message.type === 'COMMIT' && (typeof message.text !== 'string' || message.text.length > 240000)) throw new Error('英文结果格式不可用。');
  const request = {
    mode: { PREPARE: 'prepare', COMMIT: 'commit', CANCEL_FILL: 'cancel' }[message.type],
    expected,
    ...(message.type === 'COMMIT' ? { text: message.text, replace: message.replace === true, token: message.token } : {})
  };
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId: actual.tabId, documentIds: [actual.documentId] },
    world: 'ISOLATED', func: claudeAdapter, args: [request]
  });
  if (!frame?.result) throw new Error('页面已关闭或导航，请复制英文手动粘贴。');
  return frame.result;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('sidepanel.html')) return false;
  handle(message).then(respond, () => respond({ ok: false, message: '无法操作当前页面：页面可能变化或授权已失效。请回 Claude 再点扩展图标；也可复制英文。' }));
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(`draft:${tabId}:`));
  if (keys.length) await chrome.storage.session.remove(keys);
});
