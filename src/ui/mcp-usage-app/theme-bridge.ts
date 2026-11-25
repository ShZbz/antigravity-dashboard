import {
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import type { HostThemeConfig } from '../../contracts/ipc.ts';
import createAgPulseTheme, { type AgPulseThemeAttachment, type ThemeMode } from '../theme/index.ts';

export interface McpThemeBridge {
  applyHostContext(ctx?: McpUiHostContext | null): void;
  setHostTheme(theme?: HostThemeConfig | null): void;
  dispose(): void;
}

const HOST_ROOT_STYLE_ID = 'ag-pulse-mcp-root-theme';

function ensureStyleElement(parent: HTMLElement | ShadowRoot, id: string, cssText: string): void {
  const doc = parent instanceof ShadowRoot ? parent.ownerDocument : parent.ownerDocument;
  const existing = parent instanceof ShadowRoot ? parent.getElementById(id) : doc.getElementById(id);
  if (existing) return;
  const style = doc.createElement('style');
  style.id = id;
  style.textContent = cssText;
  parent.append(style);
}

/**
 * Bridges MCP Apps host theme & SEP-1865 CSS variables onto `createAgPulseTheme()`
 * and `--pulse-*` tokens inside the usage dashboard shadow root.
 */
export function createMcpThemeBridge(targetHost: HTMLElement, shadowRoot: ShadowRoot): McpThemeBridge {
  const themeController = createAgPulseTheme();
  if (document.head) {
    ensureStyleElement(document.head, HOST_ROOT_STYLE_ID, themeController.css(':root'));
  }
  ensureStyleElement(shadowRoot, 'ag-pulse-mcp-shadow-theme', themeController.shadowCss());

  const attachment: AgPulseThemeAttachment = themeController.attach(targetHost);
  const mergedVars: Record<string, string | undefined> = {};
  let lastHostTheme: HostThemeConfig | null = null;

  const activeThemeMode = (): ThemeMode => {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
    return targetHost.dataset.pulseTheme === 'light' ? 'light' : 'dark';
  };

  const syncOuterDocument = (): void => {
    const mode = targetHost.dataset.pulseTheme;
    if (mode === 'light' || mode === 'dark') {
      document.documentElement.dataset.pulseTheme = mode;
    }
    const bg = targetHost.style.getPropertyValue('--pulse-background').trim();
    const fg = targetHost.style.getPropertyValue('--pulse-foreground').trim();
    if (document.body) {
      document.body.style.background = bg || 'var(--color-background-primary, var(--pulse-background, #1c1d1f))';
      document.body.style.color = fg || 'var(--color-text-primary, var(--pulse-foreground, #e1e3e7))';
      document.body.style.fontFamily = 'var(--font-sans, system-ui, -apple-system, sans-serif)';
    }
  };

  const syncHostVariableBridges = (): void => {
    const rootStyle = document.documentElement.style;
    const vars = mergedVars;

    const setOrClear = (prop: string, value: string | undefined): void => {
      if (value && value.trim()) rootStyle.setProperty(prop, value.trim());
      else rootStyle.removeProperty(prop);
    };

    setOrClear('--background', vars['--color-background-primary']);
    setOrClear('--card', vars['--color-background-secondary'] ?? vars['--color-background-tertiary']);
    setOrClear('--popover', vars['--color-background-secondary'] ?? vars['--color-background-tertiary']);
    setOrClear('--foreground', vars['--color-text-primary']);
    setOrClear('--border', vars['--color-border-primary']);

    const mode = activeThemeMode();
    const hasSeedPrimary = Boolean(lastHostTheme?.[mode]?.primary);
    setOrClear('--primary', hasSeedPrimary ? undefined : vars['--color-ring-primary']);

    const fontSans = vars['--font-sans']?.trim();
    const fontMono = vars['--font-mono']?.trim();
    if (fontSans) {
      rootStyle.setProperty('--pulse-font', fontSans);
      targetHost.style.setProperty('--pulse-font', fontSans);
    } else {
      rootStyle.removeProperty('--pulse-font');
      targetHost.style.removeProperty('--pulse-font');
    }
    if (fontMono) {
      rootStyle.setProperty('--pulse-mono', fontMono);
      targetHost.style.setProperty('--pulse-mono', fontMono);
    } else {
      rootStyle.removeProperty('--pulse-mono');
      targetHost.style.removeProperty('--pulse-mono');
    }
  };

  const applyHostContext = (ctx?: McpUiHostContext | null): void => {
    if (!ctx) return;
    if (ctx.styles?.variables) {
      for (const [k, v] of Object.entries(ctx.styles.variables)) {
        if (v !== undefined) mergedVars[k] = v;
      }
    }

    if (ctx.theme) {
      applyDocumentTheme(ctx.theme);
    }
    if (ctx.styles?.css?.fonts) {
      applyHostFonts(ctx.styles.css.fonts);
    }
    if (ctx.styles?.variables) {
      applyHostStyleVariables(ctx.styles.variables);
    }
    syncHostVariableBridges();
    attachment.update();
    syncOuterDocument();
  };

  const setHostTheme = (theme?: HostThemeConfig | null): void => {
    lastHostTheme = theme ?? null;
    syncHostVariableBridges();
    attachment.setHostTheme(theme ?? null);
    syncOuterDocument();
  };

  syncOuterDocument();

  return {
    applyHostContext,
    setHostTheme,
    dispose() {
      attachment.dispose();
    },
  };
}
