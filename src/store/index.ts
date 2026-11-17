/** Zustand Store — 全局状态管理 */
import { create } from 'zustand';
import type {
  FileNode, PageInfo, EditAction, SelectedElementInfo,
  AIAdapterSettings, ImportState, ToastMessage, AppState
} from '../types';
import { parseZip, buildFileTreeFromFiles, readFileAsText, readFileAsBuffer, createZip } from '../utils/zip';
import { supportsFileSystemAccess, pickDirectory, readDirectoryRecursively, downloadBlob } from '../utils/fileAccess';
import { describeElement, inlineResources } from '../utils/dom';
import { DeckDocument, sourceSelector } from '../utils/deckDocument';
import { SLIDE_SELECTORS, FORMAT_PAINTER_PROPERTIES } from '../utils/constants';

interface AppStore extends AppState {
  deck: DeckDocument | null;
  importFiles: (files: FileList) => Promise<void>;
  importDirectory: () => Promise<void>;
  selectPage: (index: number) => void;
  setEditMode: (mode: boolean) => void;
  selectElement: (info: SelectedElementInfo | null) => void;
  applyStyle: (property: string, value: string) => void;
  commitText: (selector: string, html: string) => void;
  replaceImage: (imageData: string) => void;
  applyHtml: (html: string) => void;
  undo: () => void;
  redo: () => void;
  setZoom: (zoom: number) => void;
  saveToFile: () => Promise<void>;
  exportZip: () => Promise<void>;
  exportSingleHtml: () => Promise<void>;
  restoreOriginal: () => void;
  addToast: (message: string, type: ToastMessage['type']) => void;
  removeToast: (id: string) => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  setAISettings: (settings: Partial<AIAdapterSettings>) => void;
  setShowSettings: (show: boolean) => void;
  setImportState: (state: Partial<ImportState>) => void;
  resetState: () => void;
  copyFormatPainter: () => void;
  toggleFormatPainter: () => void;
  setFormatPainterSticky: (sticky: boolean) => void;
  applyFormatPainter: (target: SelectedElementInfo) => void;
  clearFormatPainter: () => void;
}

const initialState: AppState = {
  fileTree: [],
  currentFile: null,
  pages: [],
  currentPageIndex: -1,
  isEditMode: false,
  selectedElement: null,
  zoom: 100,
  undoStack: [],
  redoStack: [],
  importState: {
    isImporting: false,
    progress: 0,
    totalFiles: 0,
    processedFiles: 0,
  },
  aiSettings: {
    provider: 'openai',
    apiKey: '',
    enabled: false,
  },
  toasts: [],
  leftPanelCollapsed: false,
  rightPanelCollapsed: false,
  showSettings: false,
  hasImported: false,

  // 格式刷
  formatPainterSource: null,
  formatPainterActive: false,
  formatPainterSticky: false,
};

export const useStore = create<AppStore>((set, get) => {
  let importVersion = 0;

  function openDeck(fileTree: FileNode[]) {
    const main = fileTree.find(n => n.isMainHtml) || fileTree.find(n => /\.html?$/i.test(n.name));
    if (!main) throw new Error('找不到 HTML 文件');
    const deck = new DeckDocument(main);
    set({
      deck, fileTree, currentFile: main.path, hasImported: true,
      pages: parsePageStructure(deck.source, main.path), currentPageIndex: 0,
      selectedElement: null, undoStack: [], redoStack: [], formatPainterSource: null,
      formatPainterActive: false, formatPainterSticky: false, importState: initialState.importState,
    });
  }

  function applyAction(action: EditAction, direction: 'before' | 'after', alreadyTyped = false) {
    const { deck, selectedElement, addToast } = get();
    if (!deck?.apply(action, direction, alreadyTyped)) {
      addToast('无法唯一定位原元素，修改未应用', 'warning');
      return false;
    }
    if (action.changes.some(c => c.type === 'content' || c.type === 'element')) {
      const pages = parsePageStructure(deck.source, get().currentFile!);
      set({ pages, currentPageIndex: Math.min(get().currentPageIndex, pages.length - 1) });
    }
    if (selectedElement) {
      const el = deck.previewElement(selectedElement.selector);
      set({ selectedElement: el ? describeElement(el, selectedElement.selector) : null });
    }
    return true;
  }

  function commit(target: string, changes: EditAction['changes'], alreadyTyped = false) {
    const action = { target, changes: changes.filter(c => c.before !== c.after) };
    if (!action.changes.length || !applyAction(action, 'after', alreadyTyped)) return false;
    set(state => ({ undoStack: [...state.undoStack, action], redoStack: [] }));
    return true;
  }

  function travel(direction: 'before' | 'after') {
    get().deck?.finishTyping();
    const from = direction === 'before' ? 'undoStack' : 'redoStack';
    const to = direction === 'before' ? 'redoStack' : 'undoStack';
    const state = get();
    const action = state[from].at(-1);
    if (action && applyAction(action, direction)) {
      set({ [from]: state[from].slice(0, -1), [to]: [...state[to], action] });
    }
  }

  function exportTree() {
    get().deck?.finishTyping();
    const { fileTree, deck, currentFile, undoStack } = get();
    if (!deck || !undoStack.length) return fileTree;
    return fileTree.map(node => node.path === currentFile ? { ...node, content: deck.serialize() } : node);
  }

  return {
    ...initialState,
    deck: null,

    importFiles: async (files) => {
      const version = ++importVersion;
      const { addToast } = get();
      set({ importState: { ...initialState.importState, isImporting: true, progress: 0 } });

      try {
        let fileTree: FileNode[] = [];
        const fileArray = Array.from(files);
        const zipFile = fileArray.find(f => /\.zip$/i.test(f.name));
        const htmlFiles = fileArray.filter(f => /\.html?$/i.test(f.name));

        if (zipFile) {
          fileTree = await parseZip(zipFile);
        } else if (htmlFiles.length > 0) {
          fileTree = buildFileTreeFromFiles(files);
          for (const node of fileTree) {
            if (node.type !== 'file') continue;
            const file = fileArray.find((f) => f.name === node.name);
            if (!file) continue;
            if (/\.html?$/i.test(node.name)) {
              node.content = await readFileAsText(file);
            } else {
              node.content = await readFileAsBuffer(file);
            }
          }
        } else {
          addToast('请上传 HTML 文件或 ZIP 文件', 'warning');
          set({ importState: { ...initialState.importState, isImporting: false } });
          return;
        }

        if (version !== importVersion) return;
        openDeck(fileTree);
        addToast(zipFile ? 'ZIP 文件解析成功' : 'HTML 文件导入成功', 'success');
      } catch (err) {
        if (version !== importVersion) return;
        console.error('Import failed:', err);
        addToast('导入失败: ' + (err instanceof Error ? err.message : '未知错误'), 'error');
        set({ importState: { ...initialState.importState, isImporting: false } });
      }
    },

    importDirectory: async () => {
      const version = ++importVersion;
      const { addToast } = get();
      try {
        if (!supportsFileSystemAccess()) {
          addToast('您的浏览器不支持文件夹选择，请使用 Chrome 或 Edge', 'warning');
          return;
        }
        const dirHandle = await pickDirectory();
        if (version !== importVersion) return;
        set({ importState: { ...initialState.importState, isImporting: true, progress: 0 } });
        const fileTree = await readDirectoryRecursively(dirHandle);
        if (version !== importVersion) return;
        openDeck(fileTree);
        addToast('文件夹导入成功', 'success');
      } catch (err) {
        if (version !== importVersion) return;
        console.error('Directory import failed:', err);
        addToast('文件夹导入失败', 'error');
        set({ importState: { ...initialState.importState, isImporting: false } });
      }
    },

    selectPage: (index) => {
      get().deck?.finishTyping();
      set({ currentPageIndex: index, selectedElement: null });
    },

    setEditMode: (mode) => {
      get().deck?.finishTyping();
      set({ isEditMode: mode, selectedElement: null });
    },

    selectElement: (info) => {
      set({ selectedElement: info });
    },

    applyStyle: (property, value) => {
      const { deck, selectedElement } = get();
      if (deck && selectedElement) {
        commit(selectedElement.selector, deck.styleChanges(selectedElement.selector, { [property]: value }));
      }
    },

    commitText: (target, html) => {
      const el = get().deck?.source.querySelector(target);
      if (el) commit(target, [{ type: 'content', before: el.innerHTML, after: html }], true);
    },

    replaceImage: (imageData) => {
      const { deck, selectedElement } = get();
      if (!selectedElement || !deck) return;
      const target = selectedElement.selector;
      const img = deck.source.querySelector(target);
      if (img?.localName !== 'img') return;
      commit(target, [
        { type: 'attribute', name: 'src', before: img.getAttribute('src'), after: imageData },
        { type: 'attribute', name: 'srcset', before: img.getAttribute('srcset'), after: null },
      ]);
    },

    applyHtml: (html) => {
      const { deck, selectedElement } = get();
      if (!selectedElement || !deck) return;
      const target = selectedElement.selector;
      const el = deck.source.querySelector(target);
      if (el && commit(target, [{ type: 'element', before: el.outerHTML, after: html }])) {
        set({ selectedElement: null });
      }
    },

    undo: () => travel('before'),
    redo: () => travel('after'),

    setZoom: (zoom) => {
      set({ zoom });
    },

    saveToFile: async () => {
      const { currentFile, addToast } = get();
      const fileTree = exportTree();
      if (!currentFile || fileTree.length === 0) {
        addToast('没有可保存的文件', 'warning');
        return;
      }
      try {
        const htmlNode = fileTree.find((n) => n.path === currentFile);
        if (!htmlNode || !htmlNode.content) {
          addToast('找不到文件内容', 'error');
          return;
        }
        const content = typeof htmlNode.content === 'string'
          ? htmlNode.content
          : new TextDecoder().decode(htmlNode.content);
        const blob = new Blob([content], { type: 'text/html' });
        downloadBlob(blob, htmlNode.name);
        addToast('文件已保存', 'success');
      } catch {
        addToast('保存失败', 'error');
      }
    },

    exportZip: async () => {
      const { addToast } = get();
      const fileTree = exportTree();
      if (fileTree.length === 0) {
        addToast('没有可导出的文件', 'warning');
        return;
      }
      try {
        addToast('正在打包 ZIP...', 'info');
        const blob = await createZip(fileTree);
        downloadBlob(blob, 'deckforge-export.zip');
        addToast('ZIP 导出成功', 'success');
      } catch {
        addToast('ZIP 导出失败', 'error');
      }
    },

    exportSingleHtml: async () => {
      const { currentFile, addToast } = get();
      const fileTree = exportTree();
      if (!currentFile || fileTree.length === 0) {
        addToast('没有可导出的文件', 'warning');
        return;
      }
      try {
        const htmlNode = fileTree.find((n) => n.path === currentFile);
        if (!htmlNode || !htmlNode.content) {
          addToast('找不到文件内容', 'error');
          return;
        }
        const content = typeof htmlNode.content === 'string'
          ? htmlNode.content
          : new TextDecoder().decode(htmlNode.content);
        const inlined = inlineResources(content, fileTree);
        const blob = new Blob([inlined], { type: 'text/html' });
        downloadBlob(blob, 'deckforge-export.html');
        addToast('单 HTML 导出成功', 'success');
      } catch {
        addToast('导出失败', 'error');
      }
    },

    restoreOriginal: () => {
      const { fileTree, addToast } = get();
      if (!fileTree.length) return;
      openDeck(fileTree);
      addToast('已恢复到初始状态', 'success');
    },

    addToast: (message, type) => {
      const id = crypto.randomUUID();
      const toast: ToastMessage = { id, message, type, duration: 3000 };
      set((state) => ({ toasts: [...state.toasts, toast] }));
      setTimeout(() => {
        get().removeToast(id);
      }, toast.duration);
    },

    removeToast: (id) => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
    },

    toggleLeftPanel: () => {
      set((state) => ({ leftPanelCollapsed: !state.leftPanelCollapsed }));
    },

    toggleRightPanel: () => {
      set((state) => ({ rightPanelCollapsed: !state.rightPanelCollapsed }));
    },

    setAISettings: (settings) => {
      set((state) => ({
        aiSettings: { ...state.aiSettings, ...settings },
      }));
    },

    setShowSettings: (show) => {
      set({ showSettings: show });
    },

    setImportState: (state) => {
      set((s) => ({ importState: { ...s.importState, ...state } }));
    },

    resetState: () => {
      importVersion++;
      set({ ...initialState, deck: null });
    },

    copyFormatPainter: () => {
      const { selectedElement, addToast } = get();
      if (!selectedElement) {
        addToast('请先选中一个元素再复制格式', 'warning');
        return;
      }
      set({
        formatPainterSource: { ...selectedElement },
        formatPainterActive: true,
        formatPainterSticky: false,
      });
      addToast('格式已复制，点击目标元素应用', 'success');
    },

    toggleFormatPainter: () => {
      const { formatPainterActive, formatPainterSource, selectedElement, copyFormatPainter, clearFormatPainter } = get();
      if (!formatPainterActive) {
        if (!formatPainterSource && selectedElement) {
          copyFormatPainter();
        } else if (formatPainterSource) {
          set({ formatPainterActive: true });
        }
      } else {
        clearFormatPainter();
      }
    },

    setFormatPainterSticky: (sticky) => {
      set({ formatPainterSticky: sticky });
    },

    applyFormatPainter: (target) => {
      const { deck, formatPainterSource, addToast, clearFormatPainter, formatPainterSticky } = get();
      if (!deck) return;
      if (!formatPainterSource) {
        addToast('没有可复制应用的格式', 'warning');
        return;
      }
      if (!target) {
        addToast('请先选中目标元素', 'warning');
        return;
      }
      if (formatPainterSource.selector === target.selector) {
        addToast('不能将格式应用到源元素自身', 'warning');
        return;
      }

      const stylesToApply: Record<string, string> = {};
      const targetStyles = target.computedStyles;

      for (const property of FORMAT_PAINTER_PROPERTIES) {
        const value = formatPainterSource.computedStyles[property];
        if (value && value !== targetStyles[property]) {
          stylesToApply[property] = value;
        }
      }

      if (Object.keys(stylesToApply).length === 0) {
        addToast('目标元素已具有相同格式', 'info');
        return;
      }

      if (!commit(target.selector, deck.styleChanges(target.selector, stylesToApply))) return;
      addToast(`已应用 ${Object.keys(stylesToApply).length} 项格式`, 'success');

      if (!formatPainterSticky) {
        clearFormatPainter();
      }
    },

    clearFormatPainter: () => {
      set({
        formatPainterSource: null,
        formatPainterActive: false,
        formatPainterSticky: false,
      });
    },
  };
});

/**
 * 解析 HTML 页面结构，识别 slides
 */
function parsePageStructure(doc: Document, filePath: string): PageInfo[] {
  for (const family of SLIDE_SELECTORS) {
    const matches = Array.from(doc.body.querySelectorAll<HTMLElement>(family));
    if (!matches.length) continue;
    // reveal.js counts the leaves of a vertical slide stack. For plain HTML
    // the outer section is the page; its nested sections are page content.
    const elements = family === '.reveal .slides section'
      ? matches.filter(el => !el.querySelector('section'))
      : matches.filter(el => !el.parentElement?.closest(family));
    return elements.map((el, index) => {
      const selector = sourceSelector(el);
      return { id: selector, index, selector, type: detectPageType(el),
        title: extractTitle(el) || `页面 ${index + 1}` };
    });
  }
  return [{ id: 'body', index: 0, selector: 'body', type: 'unknown', title: extractTitle(doc.body) || filePath }];
}

function extractTitle(el: HTMLElement): string | undefined {
  const heading = el.querySelector('h1, h2, h3, .title, [data-title]');
  if (heading) return heading.textContent?.trim() || undefined;
  const firstText = el.textContent?.trim();
  if (firstText) return firstText.slice(0, 30) + (firstText.length > 30 ? '...' : '');
  return undefined;
}

function detectPageType(el: Element): PageInfo['type'] {
  const className = el.className?.toLowerCase?.() || '';
  const tagName = el.tagName?.toLowerCase?.() || '';
  if (className.includes('cover') || className.includes('title')) return 'cover';
  if (className.includes('chapter')) return 'chapter';
  if (className.includes('transition')) return 'transition';
  if (className.includes('data') || className.includes('chart')) return 'data';
  if (tagName === 'section' || className.includes('slide') || className.includes('page')) return 'slide';
  return 'unknown';
}
